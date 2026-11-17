// This file is hand-written, not generated: the uploader behind batch.Upload and kb.Ingestion.Sync's upload step
// (PROTOCOL.md 15): at most a given number of form POSTs at once under the batch's upload policy, renewed when it runs
// short or a 403 says it expired, and CompleteIngestionBatchUploads for the uploads that finish, 100 a call.

package caitlyn

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/caitlyn-ai/sdk/go/core"
)

// uploadFile is one file ready to be sent for an item: its bytes, and the checksum the form carries (the item's
// sha256, standard base64).
type uploadFile struct {
	prepared *core.PreparedFile
	// path names the file in messages: the item's path.
	path        string
	checksum    string
	contentType string
}

type uploadJob struct {
	item IngestionBatchItem
	file *uploadFile
	// again is true for the one re-upload after CompleteIngestionBatchUploads found a checksum mismatch.
	again bool
}

// uploader sends a batch's files. Its callbacks are called from several goroutines; the caller serialises them.
type uploader struct {
	c           *Client
	kb, batchID string
	concurrency int
	progress    func(IngestionProgress)
	// failed is an item that failed during the call: its upload (UPLOAD_FAILED, FILE_CHANGED), or Complete refusing
	// it (a second CHECKSUM_MISMATCH, or another code), when byComplete is true.
	failed func(it IngestionBatchItem, byComplete bool)
	// accepted is an upload Complete accepted.
	accepted func(it IngestionBatchItem)
	// queued, when true, reports phase queued after each Complete call: items accepted of items uploaded.
	queued bool
}

// policyHolder keeps the batch's current upload policy and renews it, once for all the uploads that need it.
type policyHolder struct {
	u      *uploader
	mu     sync.Mutex
	policy *UploadPolicy
	fields []core.FormField
	gen    int
}

func (h *policyHolder) set(p *UploadPolicy) error {
	fields, err := core.OrderedFields(p.RawJSON(), "formFields")
	if err != nil {
		// A policy built in code has no JSON: its fields in name order are the best there is.
		fields = nil
		for k, v := range p.FormFields {
			fields = append(fields, core.FormField{Name: k, Value: v})
		}
		sortFields(fields)
	}
	h.policy, h.fields = p, fields
	h.gen++
	return nil
}

func (h *policyHolder) renewLocked(ctx context.Context) error {
	res, err := h.u.c.Core.Ingestion.UploadPolicy(ctx, h.u.kb, h.u.batchID)
	if err != nil {
		return err
	}
	p := res.UploadPolicy
	return h.set(&p)
}

// current returns the policy to upload with, renewed first when less than 5 minutes are left.
func (h *policyHolder) current(ctx context.Context) (*UploadPolicy, []core.FormField, int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if time.Until(h.policy.ExpiresAt) < SyncPolicyRenewBefore {
		if err := h.renewLocked(ctx); err != nil {
			return nil, nil, 0, err
		}
	}
	return h.policy, h.fields, h.gen, nil
}

// expired renews the policy after a 403 that says it expired, unless another upload already renewed it since gen.
func (h *policyHolder) expired(ctx context.Context, gen int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.gen != gen {
		return nil
	}
	return h.renewLocked(ctx)
}

// run sends the jobs' files and reports them to Complete. One file's failure fails only its item; the call returns an
// error only when the context is cancelled (the context's error) or the policy cannot be renewed.
func (u *uploader) run(parent context.Context, policy *UploadPolicy, jobs []uploadJob) error {
	if len(jobs) == 0 {
		return nil
	}
	var bytesTotal int64
	for _, j := range jobs {
		bytesTotal += j.file.prepared.Size
	}
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	holder := &policyHolder{u: u}
	if err := holder.set(policy); err != nil {
		return err
	}

	queue := make(chan uploadJob, 2*len(jobs))
	uploaded := make(chan uploadJob, 2*len(jobs))
	stop := make(chan struct{})
	var pending sync.WaitGroup // jobs not yet accepted or failed by CompleteIngestionBatchUploads
	pending.Add(len(jobs))
	for _, j := range jobs {
		queue <- j
	}

	var mu sync.Mutex
	doneFiles, bytesSent, acceptedCount := 0, int64(0), 0
	u.progress(IngestionProgress{Phase: SyncPhaseUpload, Total: len(jobs), BytesTotal: bytesTotal})

	concurrency := u.concurrency
	if concurrency <= 0 {
		concurrency = DefaultSyncConcurrency
	}
	var workers sync.WaitGroup
	for range concurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-stop:
					return
				case <-ctx.Done():
					return
				case j := <-queue:
					itemErr, err := u.send(ctx, holder, j)
					if err != nil {
						cancel(err)
						return
					}
					if itemErr != nil {
						// This item fails; the other uploads carry on. It is not reported to Complete.
						it := j.item
						var ae *core.APIError
						errors.As(itemErr, &ae)
						it.Status, it.FailureCode, it.FailureDetail = IngestionItemStatusFailed, Ptr(ae.Code), Ptr(itemErr.Error())
						u.failed(it, false)
						pending.Done()
						continue
					}
					mu.Lock()
					doneFiles++
					bytesSent += j.file.prepared.Size
					p := IngestionProgress{Phase: SyncPhaseUpload, Done: doneFiles, Total: len(jobs), BytesSent: bytesSent, BytesTotal: bytesTotal, Item: &j.item}
					mu.Unlock()
					u.progress(p)
					uploaded <- j
				}
			}
		}()
	}

	// One completer reports the uploads as they finish, at most SyncCompletePerCall a call.
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			var group []uploadJob
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case j := <-uploaded:
				group = append(group, j)
			}
		drain:
			for len(group) < SyncCompletePerCall {
				select {
				case j := <-uploaded:
					group = append(group, j)
				default:
					break drain
				}
			}
			ids := make([]string, len(group))
			byID := map[string]uploadJob{}
			for i, j := range group {
				ids[i] = j.item.ID
				byID[j.item.ID] = j
			}
			res, err := u.c.Core.Ingestion.CompleteUploads(ctx, u.kb, u.batchID, &CompleteIngestionBatchUploadsInput{ItemIDs: ids})
			if err != nil {
				cancel(err)
				return
			}
			for _, cr := range res.Results {
				j, ok := byID[cr.ItemID]
				if !ok {
					continue
				}
				delete(byID, cr.ItemID)
				it := j.item
				switch {
				case cr.Status == UploadCompletionStatusAccepted:
					// Accepted is not final: the item reaches OnItem when it is indexed, or fails, at the end.
					u.accepted(it)
					mu.Lock()
					acceptedCount++
					mu.Unlock()
				case deref(cr.Code) == "CHECKSUM_MISMATCH" && !j.again:
					pending.Add(1)
					queue <- uploadJob{item: j.item, file: j.file, again: true}
				default:
					it.Status, it.FailureCode, it.FailureDetail = IngestionItemStatusFailed, cr.Code, cr.Detail
					u.failed(it, true)
				}
				pending.Done()
			}
			// An item the server left out of its answer is not left waiting.
			for range byID {
				pending.Done()
			}
			if u.queued {
				mu.Lock()
				p := IngestionProgress{Phase: SyncPhaseQueued, Done: acceptedCount, Total: doneFiles}
				mu.Unlock()
				u.progress(p)
			}
		}
	}()

	all := make(chan struct{})
	go func() {
		pending.Wait()
		close(all)
	}()
	select {
	case <-all:
	case <-ctx.Done():
	}
	close(stop)
	cancel(nil) // aborts uploads still in flight
	workers.Wait()
	if err := context.Cause(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return parent.Err()
}

// send form-POSTs one file under the current policy: the policy's fields in order, then key, Content-Type and the
// checksum fields, and the file last. A 403 that says the policy expired renews it and sends the file once more.
// itemErr fails only this item (UPLOAD_FAILED after the retries, or FILE_CHANGED); err stops the whole batch (the
// context, or a policy that could not be renewed).
func (u *uploader) send(ctx context.Context, holder *policyHolder, j uploadJob) (itemErr, err error) {
	p := j.file.prepared
	for renewed := false; ; renewed = true {
		policy, fields, gen, err := holder.current(ctx)
		if err != nil {
			return nil, err
		}
		all := append(append([]core.FormField(nil), fields...),
			core.FormField{Name: "key", Value: objectKey(j.item, policy, j.file)},
			core.FormField{Name: "Content-Type", Value: j.file.contentType},
			core.FormField{Name: "x-amz-checksum-algorithm", Value: "SHA256"},
			core.FormField{Name: "x-amz-checksum-sha256", Value: j.file.checksum},
		)
		status, body, err := u.c.core.PostForm(ctx, policy.UploadURL, all, p)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			var ae *core.APIError
			if errors.As(err, &ae) && ae.Code != "" {
				return ae, nil // FILE_CHANGED
			}
			return core.NewError("UPLOAD_FAILED", "The bytes of "+j.file.path+" could not be sent", err), nil
		}
		if status >= 200 && status < 300 {
			return nil, nil
		}
		if status == http.StatusForbidden && !renewed && policyExpired(body) {
			if err := holder.expired(ctx, gen); err != nil {
				return nil, err
			}
			continue
		}
		if status == http.StatusBadRequest && bytes.Contains(body, []byte("BadDigest")) {
			// Storage refused bytes that do not match the item's checksum: the file is not the one the item was
			// planned from, and sending it again cannot succeed
			return core.NewError("FILE_CHANGED", j.file.path+" is not the file the item was planned from: its bytes do not match the item's checksum",
				&core.HTTPStatusError{Status: status, Body: body}), nil
		}
		return core.NewError("UPLOAD_FAILED", "The upload URL refused "+j.file.path, &core.HTTPStatusError{Status: status, Body: body}), nil
	}
}

// policyExpired reports whether a 403's body says the policy has expired, as S3's "Invalid according to Policy:
// Policy expired." does.
func policyExpired(body []byte) bool {
	return bytes.Contains(bytes.ToLower(body), []byte("expired"))
}

// objectKey is where an item's bytes go: the key the server gave it, else the policy's prefix, the URL-safe SHA-256
// and the file's extension.
func objectKey(it IngestionBatchItem, policy *UploadPolicy, f *uploadFile) string {
	if it.ObjectKey != nil && *it.ObjectKey != "" {
		return *it.ObjectKey
	}
	digest, _ := base64.StdEncoding.DecodeString(f.checksum)
	return policy.KeyPrefix + base64.RawURLEncoding.EncodeToString(digest) + strings.ToLower(path.Ext(f.path))
}

func sortFields(fields []core.FormField) {
	for i := 1; i < len(fields); i++ {
		for k := i; k > 0 && fields[k].Name < fields[k-1].Name; k-- {
			fields[k], fields[k-1] = fields[k-1], fields[k]
		}
	}
}
