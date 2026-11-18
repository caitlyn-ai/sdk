package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/textproto"
	"strings"
)

// FormField is one field of an HTML form upload, in the order it is sent.
type FormField struct {
	Name  string
	Value string
}

// OrderedFields reads the string entries of the object member of raw (a JSON object) in the order the JSON has them.
// An upload policy's formFields must be sent in that order (PROTOCOL.md 15), which a Go map does not keep.
func OrderedFields(raw json.RawMessage, member string) ([]FormField, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	inner, ok := obj[member]
	if !ok {
		return nil, fmt.Errorf("caitlyn: no %s in the upload policy", member)
	}
	dec := json.NewDecoder(bytes.NewReader(inner))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, fmt.Errorf("caitlyn: %s is not an object", member)
	}
	var out []FormField
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return nil, err
		}
		var v string
		if err := dec.Decode(&v); err != nil {
			return nil, fmt.Errorf("caitlyn: %s.%v is not a string: %w", member, k, err)
		}
		out = append(out, FormField{Name: k.(string), Value: v})
	}
	return out, nil
}

// PostForm sends a prepared file as an HTML form upload (multipart/form-data) to url: fields in order, then the file
// last, as the part named "file" with its content type. It is retried as SendRaw retries, each attempt reading the
// file afresh (so a path changed since it was hashed fails with FILE_CHANGED). It returns the response's status and
// the start of its body.
func (c *Client) PostForm(ctx context.Context, url string, fields []FormField, p *PreparedFile) (int, []byte, error) {
	var head bytes.Buffer
	w := multipart.NewWriter(&head)
	for _, f := range fields {
		if err := w.WriteField(f.Name, f.Value); err != nil {
			return 0, nil, err
		}
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, quoteEscaper.Replace(p.Name)))
	h.Set("Content-Type", p.ContentType)
	if _, err := w.CreatePart(h); err != nil {
		return 0, nil, err
	}
	tail := "\r\n--" + w.Boundary() + "--\r\n"
	headers := map[string]string{"Content-Type": w.FormDataContentType()}
	length := int64(head.Len()) + p.Size + int64(len(tail))
	return c.SendRaw(ctx, "POST", url, func() (io.ReadCloser, map[string]string, int64, error) {
		file, err := p.Open()
		if err != nil {
			return nil, nil, 0, err
		}
		body := io.MultiReader(bytes.NewReader(head.Bytes()), file, strings.NewReader(tail))
		return readCloser{body, file}, headers, length, nil
	})
}

// ownFields are the form fields an upload sends itself after the policy's (PROTOCOL.md 15, step 6), lower-cased.
var ownFields = map[string]bool{"key": true, "content-type": true, "x-amz-checksum-algorithm": true, "x-amz-checksum-sha256": true, "file": true}

// WithoutOwnFields returns a policy's form fields less any the upload sends itself, compared without regard to case as
// storage compares form field names, so that no field is sent twice: storage refuses a form that repeats one.
func WithoutOwnFields(fields []FormField) []FormField {
	out := make([]FormField, 0, len(fields))
	for _, f := range fields {
		if !ownFields[strings.ToLower(f.Name)] {
			out = append(out, f)
		}
	}
	return out
}

var quoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"")

type readCloser struct {
	io.Reader
	io.Closer
}

// NewError is an error an SDK helper raises itself: Status 0, with a stable code (FILE_TOO_LARGE,
// INGESTION_BATCH_UNRESOLVED…), a title and the cause, if any.
func NewError(code, title string, cause error) *APIError { return sdkError(code, title, cause) }
