//go:build caitlyn_conformance

package caitlyn

import "context"

// SetSyncEstimatePerCall sets the most documents one EstimateIngestion call of a Sync with these options takes, in
// place of 10,000. It exists only in a build with -tags caitlyn_conformance, for the conformance suite's
// [sync.estimate-many]; it is not part of the SDK.
func SetSyncEstimatePerCall(o *SyncOptions, n int) { o.estimatePerCall = n }

// WithEstimatePerCall is ctx with the most documents one EstimateIngestion call of batch.EstimateUpload takes, in
// place of 10,000. It exists only in a build with -tags caitlyn_conformance, for the conformance suite's
// [batch-estimate.many]; it is not part of the SDK.
func WithEstimatePerCall(ctx context.Context, n int) context.Context {
	return context.WithValue(ctx, estimatePerCallKey{}, n)
}
