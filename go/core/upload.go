package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
)

// UploadFile is a file to upload with a presigned URL (PROTOCOL.md 10, Uploads).
type UploadFile struct {
	Name        string
	ContentType string
	Data        []byte
}

// FileFromPath reads a file, taking its content type from the extension.
func FileFromPath(path string) (*UploadFile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	ct := mime.TypeByExtension(filepath.Ext(path))
	if ct == "" {
		ct = "application/octet-stream"
	}
	return &UploadFile{Name: filepath.Base(path), ContentType: ct, Data: b}, nil
}

// SHA256 is the base64 SHA-256 of the file's bytes.
func (f *UploadFile) SHA256() string {
	sum := sha256.Sum256(f.Data)
	return base64.StdEncoding.EncodeToString(sum[:])
}

// PutPresigned sends the bytes to a presigned URL with exactly the headers the reservation requires.
// No SDK header or credential is sent there.
func (c *Client) PutPresigned(ctx context.Context, method, url string, headers map[string]string, data []byte) error {
	if method == "" {
		method = http.MethodPut
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(data))
	if err != nil {
		return sdkError("UPLOAD_PUT_FAILED", "The upload URL could not be used", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.s.httpClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return sdkError("UPLOAD_PUT_FAILED", "The bytes could not be sent", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return sdkError("UPLOAD_PUT_FAILED", "The upload URL refused the bytes", fmt.Errorf("HTTP %d", resp.StatusCode))
	}
	return nil
}
