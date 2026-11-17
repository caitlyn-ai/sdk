package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Files (PROTOCOL.md 14): one UploadFile type for a path, bytes or a stream; the SHA-256 known before anything is
// sent, from streaming reads; a stream that cannot be read twice copied aside while it is hashed; the 2 GB limit;
// a path that changes between hashing and sending refused.

// MaxFileSize is the largest file an upload takes: 2 GB (2,147,483,648 bytes).
const MaxFileSize int64 = 2 << 30

// SpoolMemoryLimit is how much of a stream is kept in memory while it is hashed; past it, the copy is a temporary
// file readable only by its owner, removed when the call ends.
const SpoolMemoryLimit = 8 << 20

// UploadFile is a file to upload: from a path (FileFromPath), bytes (FileFromBytes) or a stream (FileFromReader).
// Nothing is read until a call uses it, and then once, with streaming reads.
type UploadFile struct {
	name        string
	contentType string
	path        string
	data        []byte
	reader      io.Reader
	size        int64 // a stream's length when known, else -1
	hints       any   // what an estimate sends about the file's contents (WithHints), in the generated package's type

	mu   sync.Mutex
	read bool // a stream has been read
}

// FileOption sets a property of an UploadFile: WithContentType, WithSize.
type FileOption func(*UploadFile)

// WithContentType sets the file's media type, in place of the one its name's extension gives.
func WithContentType(contentType string) FileOption {
	return func(f *UploadFile) { f.contentType = contentType }
}

// WithSize gives a stream's length when it is known (an HTTP response's ContentLength, for example), so a stream over
// 2 GB fails before it is read. A negative size means unknown, and the stream is counted as it is read.
func WithSize(size int64) FileOption {
	return func(f *UploadFile) {
		if size < 0 {
			size = -1
		}
		f.size = size
	}
}

// FileFromPath is the file at path. Its name is the path's last element and its content type comes from the
// extension unless WithContentType sets one. It fails when path is not a regular file; the bytes are read later,
// when a call uses the file, and its size and modification time are checked again before they are sent.
func FileFromPath(p string, opts ...FileOption) (*UploadFile, error) {
	fi, err := os.Stat(p)
	if err != nil {
		return nil, unreadable(p, err)
	}
	if !fi.Mode().IsRegular() {
		return nil, unreadable(p, fmt.Errorf("%s is not a regular file", p))
	}
	f := &UploadFile{name: filepath.Base(p), path: p, size: fi.Size()}
	return f.with(opts), nil
}

// FileFromBytes is a file named name (which gives the content type, unless WithContentType sets one) holding data.
// The slice is not copied: do not change it until the call that uses the file has returned.
func FileFromBytes(name string, data []byte, opts ...FileOption) *UploadFile {
	f := &UploadFile{name: name, data: data, size: int64(len(data))}
	if data == nil {
		f.data = []byte{}
	}
	return f.with(opts)
}

// FileFromReader is a file named name (which gives the content type, unless WithContentType sets one) read from r.
// The stream is read once, by the first call that uses the file: it is copied aside while it is hashed (in memory up
// to 8 MiB, past that to a temporary file only its owner can read, removed when the call ends), and the copy is sent.
// Use a fresh UploadFile for each call. WithSize gives its length when it is known.
func FileFromReader(name string, r io.Reader, opts ...FileOption) *UploadFile {
	f := &UploadFile{name: name, reader: r, size: -1}
	return f.with(opts)
}

func (f *UploadFile) with(opts []FileOption) *UploadFile {
	for _, o := range opts {
		o(f)
	}
	if f.contentType == "" {
		f.contentType = ContentTypeFor(f.name)
	}
	return f
}

// Name is the file's name: the path's last element, or the name given with the bytes or stream.
func (f *UploadFile) Name() string { return f.name }

// ContentType is the file's media type: WithContentType's, else the one its extension gives.
func (f *UploadFile) ContentType() string { return f.contentType }

// Hints are what WithHints gave, for an estimate's description of the file; nil when none were given.
func (f *UploadFile) Hints() any { return f.hints }

// WithHints gives what an estimate may send about a file's contents besides its size, such as its page count (the
// generated package's IngestionHints). The SDK reads none from the bytes itself.
func WithHints(h any) FileOption { return func(f *UploadFile) { f.hints = h } }

// Path is the file's path, or "" for bytes and streams.
func (f *UploadFile) Path() string { return f.path }

// contentTypes is the extension table every SDK shares (PROTOCOL.md 14): conformance/cases/content-types.json's
// entries, which the files.content-type case checks.
var contentTypes = map[string]string{
	".csv":      "text/csv",
	".doc":      "application/msword",
	".docx":     "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".eml":      "message/rfc822",
	".flac":     "audio/flac",
	".gif":      "image/gif",
	".htm":      "text/html",
	".html":     "text/html",
	".jpeg":     "image/jpeg",
	".jpg":      "image/jpeg",
	".json":     "application/json",
	".m4a":      "audio/mp4",
	".markdown": "text/markdown",
	".md":       "text/markdown",
	".mov":      "video/quicktime",
	".mp3":      "audio/mpeg",
	".mp4":      "video/mp4",
	".odt":      "application/vnd.oasis.opendocument.text",
	".ogg":      "audio/ogg",
	".pdf":      "application/pdf",
	".png":      "image/png",
	".ppt":      "application/vnd.ms-powerpoint",
	".pptx":     "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".rtf":      "application/rtf",
	".svg":      "image/svg+xml",
	".tif":      "image/tiff",
	".tiff":     "image/tiff",
	".txt":      "text/plain",
	".wav":      "audio/wav",
	".webm":     "video/webm",
	".webp":     "image/webp",
	".xls":      "application/vnd.ms-excel",
	".xlsx":     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xml":      "application/xml",
	".zip":      "application/zip",
}

// ContentTypeFor is the media type a file name's extension gives, from the table every SDK shares, or
// application/octet-stream for an extension not in it.
func ContentTypeFor(name string) string {
	if ct, ok := contentTypes[strings.ToLower(path.Ext(name))]; ok {
		return ct
	}
	return "application/octet-stream"
}

// FileInfo is what reserving an upload needs to know about a file: its name, content type, size and the standard
// base64 of its SHA-256.
type FileInfo struct {
	Name        string
	ContentType string
	Size        int64
	SHA256      string
}

// PreparedFile is a file that has been hashed: its FileInfo, and the bytes to send (the file itself, the bytes, or a
// stream's copy). Close it when the call ends: that removes a stream's temporary copy.
type PreparedFile struct {
	FileInfo
	// Digest is the SHA-256 itself.
	Digest [32]byte

	file    *UploadFile
	modTime time.Time
	spooled []byte
	temp    string
}

// SHA256URL is the SHA-256 in URL-safe base64 without padding, as object keys carry it.
func (p *PreparedFile) SHA256URL() string { return base64.RawURLEncoding.EncodeToString(p.Digest[:]) }

// Open returns the bytes to send, from the start. For a path it first checks the size and modification time again:
// a file changed since it was hashed fails with FILE_CHANGED, and nothing is read.
func (p *PreparedFile) Open() (io.ReadCloser, error) {
	switch {
	case p.file.path != "":
		fi, err := os.Stat(p.file.path)
		if err != nil {
			return nil, fileChanged(p.file.path, err)
		}
		if fi.Size() != p.Size || !fi.ModTime().Equal(p.modTime) {
			return nil, fileChanged(p.file.path, nil)
		}
		fh, err := os.Open(p.file.path)
		return fh, unreadable(p.file.path, err)
	case p.temp != "":
		fh, err := os.Open(p.temp)
		return fh, unreadable(p.Name, err)
	case p.spooled != nil:
		return io.NopCloser(bytes.NewReader(p.spooled)), nil
	default:
		return io.NopCloser(bytes.NewReader(p.file.data)), nil
	}
}

// Close removes a stream's temporary copy, if it has one. It is safe to call more than once.
func (p *PreparedFile) Close() error {
	if p.temp == "" {
		return nil
	}
	err := os.Remove(p.temp)
	p.temp = ""
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Prepare reads the file once, with streaming reads, for its size and SHA-256. A file over 2 GB fails with
// FILE_TOO_LARGE, before any of it is read when its size is known. A stream is copied aside as it is read; a
// stream already read by an earlier call fails. Close the result when the call ends.
func (f *UploadFile) Prepare(ctx context.Context) (*PreparedFile, error) {
	p, err := f.prepare(ctx)
	if err != nil && f != nil {
		return nil, unreadable(f.name, err)
	}
	return p, err
}

// unreadable is FILE_UNREADABLE for a file read that failed (PROTOCOL.md 6.3), with the native error as its Cause. A
// Caitlyn error, an input error and a cancellation pass as they are; nil stays nil.
func unreadable(name string, err error) error {
	var api *APIError
	var input *InputError
	if err == nil || errors.As(err, &api) || errors.As(err, &input) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return sdkError("FILE_UNREADABLE", name+" could not be read", err)
}

func (f *UploadFile) prepare(ctx context.Context) (*PreparedFile, error) {
	if f == nil {
		return nil, &InputError{Operation: "UploadFile", Member: "file", Reason: "is required"}
	}
	p := &PreparedFile{FileInfo: FileInfo{Name: f.name, ContentType: f.contentType}, file: f}
	h := sha256.New()
	switch {
	case f.path != "":
		fh, err := os.Open(f.path)
		if err != nil {
			return nil, err
		}
		defer fh.Close()
		fi, err := fh.Stat()
		if err != nil {
			return nil, err
		}
		if fi.Size() > MaxFileSize {
			return nil, fileTooLarge(f.name, fi.Size())
		}
		n, err := io.Copy(h, &ctxReader{ctx, fh})
		if err != nil {
			return nil, err
		}
		if n != fi.Size() {
			return nil, fileChanged(f.path, nil)
		}
		p.Size, p.modTime = n, fi.ModTime()
	case f.reader != nil:
		f.mu.Lock()
		already := f.read
		f.read = true
		f.mu.Unlock()
		if already {
			return nil, sdkError("FILE_ALREADY_READ", "The stream "+f.name+" was read by an earlier call: use a new UploadFile for each call", nil)
		}
		if f.size > MaxFileSize {
			return nil, fileTooLarge(f.name, f.size)
		}
		if err := p.spool(ctx, f.reader, h); err != nil {
			p.Close()
			return nil, err
		}
	default:
		if int64(len(f.data)) > MaxFileSize {
			return nil, fileTooLarge(f.name, int64(len(f.data)))
		}
		h.Write(f.data)
		p.Size = int64(len(f.data))
	}
	h.Sum(p.Digest[:0])
	p.SHA256 = base64.StdEncoding.EncodeToString(p.Digest[:])
	return p, nil
}

// PrepareUnhashed readies the file to be sent without hashing it, for an upload whose checksum is already known (an
// ingestion batch item's): a path is only stat'd (and checked again when it is opened), bytes are used as they are,
// and a stream is copied once, to memory or a temporary file, so each attempt can send it from the start. Digest and
// SHA256 are left empty.
func (f *UploadFile) PrepareUnhashed(ctx context.Context) (*PreparedFile, error) {
	p, err := f.prepareUnhashed(ctx)
	if err != nil && f != nil {
		return nil, unreadable(f.name, err)
	}
	return p, err
}

func (f *UploadFile) prepareUnhashed(ctx context.Context) (*PreparedFile, error) {
	if f == nil {
		return nil, &InputError{Operation: "UploadFile", Member: "file", Reason: "is required"}
	}
	p := &PreparedFile{FileInfo: FileInfo{Name: f.name, ContentType: f.contentType}, file: f}
	switch {
	case f.path != "":
		fi, err := os.Stat(f.path)
		if err != nil {
			return nil, err
		}
		if fi.Size() > MaxFileSize {
			return nil, fileTooLarge(f.name, fi.Size())
		}
		p.Size, p.modTime = fi.Size(), fi.ModTime()
	case f.reader != nil:
		f.mu.Lock()
		already := f.read
		f.read = true
		f.mu.Unlock()
		if already {
			return nil, sdkError("FILE_ALREADY_READ", "The stream "+f.name+" was read by an earlier call: use a new UploadFile for each call", nil)
		}
		if f.size > MaxFileSize {
			return nil, fileTooLarge(f.name, f.size)
		}
		if err := p.spool(ctx, f.reader, io.Discard); err != nil {
			p.Close()
			return nil, err
		}
	default:
		if int64(len(f.data)) > MaxFileSize {
			return nil, fileTooLarge(f.name, int64(len(f.data)))
		}
		p.Size = int64(len(f.data))
	}
	return p, nil
}

// spool copies a stream while hashing it: to memory up to SpoolMemoryLimit, then to a 0600 temporary file.
func (p *PreparedFile) spool(ctx context.Context, r io.Reader, h io.Writer) error {
	r = &ctxReader{ctx, r}
	var mem bytes.Buffer
	n, err := io.Copy(io.MultiWriter(&mem, h), io.LimitReader(r, SpoolMemoryLimit+1))
	if err != nil {
		return err
	}
	if n <= SpoolMemoryLimit {
		p.spooled, p.Size = mem.Bytes(), n
		return nil
	}
	tf, err := os.CreateTemp("", "caitlyn-upload-*")
	if err != nil {
		return err
	}
	p.temp = tf.Name()
	if err := tf.Chmod(0o600); err != nil {
		tf.Close()
		return err
	}
	if _, err := tf.Write(mem.Bytes()); err != nil {
		tf.Close()
		return err
	}
	// The rest goes to the file and the hash; one byte past the limit is enough to know it is too large.
	rest, err := io.Copy(io.MultiWriter(tf, h), io.LimitReader(r, MaxFileSize-n+1))
	if cerr := tf.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	p.Size = n + rest
	if p.Size > MaxFileSize {
		return fileTooLarge(p.Name, p.Size)
	}
	return nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(b []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(b)
}

func fileTooLarge(name string, size int64) *APIError {
	return sdkError("FILE_TOO_LARGE", fmt.Sprintf("%s is larger than 2 GB (%d bytes)", name, size), nil)
}

func fileChanged(p string, cause error) *APIError {
	return sdkError("FILE_CHANGED", p+" changed after it was read: its size or modification time is different", cause)
}

// PresignedPut is where an upload's bytes go: the method, the URL and the headers to send exactly.
type PresignedPut struct {
	Method  string
	URL     string
	Headers map[string]string
}

// SendFile prepares file, calls reserve with what it learnt (generated code reserves the upload there), then sends
// the bytes where reserve says, retried like a retry-safe call, in a caitlyn.upload span. Bytes that could not be
// sent are an *APIError with the code UPLOAD_PUT_FAILED; a stream's temporary copy is removed however the call ends.
func (c *Client) SendFile(ctx context.Context, file *UploadFile, reserve func(context.Context, FileInfo) (PresignedPut, error)) error {
	p, err := file.Prepare(ctx)
	if err != nil {
		return err
	}
	defer p.Close()
	dest, err := reserve(ctx, p.FileInfo)
	if err != nil {
		return err
	}
	return c.PutPresigned(ctx, dest, p)
}

// PutPresigned sends a prepared file to a presigned URL with exactly the headers the reservation requires, and no SDK
// header or credential, in a caitlyn.upload span (PROTOCOL.md 13). A 429, a 503 or no response is retried as for a
// retry-safe call, with the same headers and bytes.
func (c *Client) PutPresigned(ctx context.Context, dest PresignedPut, p *PreparedFile) error {
	method := dest.Method
	if method == "" {
		method = "PUT"
	}
	status, body, err := c.SendRaw(ctx, method, dest.URL, func() (io.ReadCloser, map[string]string, int64, error) {
		r, err := p.Open()
		return r, dest.Headers, p.Size, err
	})
	if err != nil {
		var ae *APIError
		if errors.As(err, &ae) && ae.Code == "FILE_CHANGED" || ctx.Err() != nil {
			return err
		}
		return sdkError("UPLOAD_PUT_FAILED", "The bytes could not be sent", err)
	}
	if status < 200 || status >= 300 {
		return sdkError("UPLOAD_PUT_FAILED", "The upload URL refused the bytes", &HTTPStatusError{Status: status, Body: body})
	}
	return nil
}
