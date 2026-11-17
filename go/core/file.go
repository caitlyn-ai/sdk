package core

import (
	"context"
	"io"
	"os"
	"strings"
)

// File is what a call that takes a file accepts (PROTOCOL.md 10, 14): a path (Path), an *UploadFile (FileFromPath,
// FileFromBytes, FileFromReader), or an upload already sent (UploadID), whose id is used as it is.
type File interface {
	isFile()
}

// Path is a file on disk, by its path: caitlyn.Path("./leave-policy.pdf").
type Path string

// UploadID is an upload already reserved and sent (Core.Uploads.Send): a call that takes a file uses its id as it is.
type UploadID string

func (*UploadFile) isFile() {}
func (Path) isFile()        {}
func (UploadID) isFile()    {}

// FileOf is the *UploadFile a File stands for: a Path opened as FileFromPath, an *UploadFile itself, and nil for an
// UploadID (there is nothing to send).
func FileOf(f File) (*UploadFile, error) {
	switch v := f.(type) {
	case *UploadFile:
		if v == nil {
			return nil, &InputError{Operation: "UploadFile", Member: "file", Reason: "is required"}
		}
		return v, nil
	case Path:
		return FileFromPath(string(v))
	case UploadID:
		if v == "" {
			return nil, &InputError{Operation: "UploadFile", Member: "file", Reason: "is an empty upload id"}
		}
		return nil, nil
	}
	return nil, &InputError{Operation: "UploadFile", Member: "file", Reason: "is required"}
}

// Describe is the file's name, content type and size, without its SHA-256: what an estimate sends in place of the
// bytes. Nothing is hashed. A path and bytes are not read; a stream of unknown length is read to count it, and a
// stream is read once, so use a new UploadFile for the call that sends it.
func (f *UploadFile) Describe(ctx context.Context) (FileInfo, error) {
	info := FileInfo{Name: f.name, ContentType: f.contentType}
	switch {
	case f.path != "":
		fi, err := os.Stat(f.path)
		if err != nil {
			return info, unreadable(f.path, err)
		}
		info.Size = fi.Size()
	case f.reader != nil:
		if f.size >= 0 {
			info.Size = f.size
			break
		}
		// Counted, not hashed: an estimate needs only the name, content type and size.
		f.mu.Lock()
		already := f.read
		f.read = true
		f.mu.Unlock()
		if already {
			return info, sdkError("FILE_ALREADY_READ", "The stream "+f.name+" was read by an earlier call: use a new UploadFile for each call", nil)
		}
		n, err := io.Copy(io.Discard, &ctxReader{ctx, io.LimitReader(f.reader, MaxFileSize+1)})
		if err != nil {
			return info, unreadable(f.name, err)
		}
		info.Size = n
	default:
		info.Size = int64(len(f.data))
	}
	if info.Size > MaxFileSize {
		return info, fileTooLarge(f.name, info.Size)
	}
	return info, nil
}

// TrimFolder is a folder path as a request path carries it: without its first and last "/" (PROTOCOL.md 10), so a
// folder scope takes "/hr/leave/" as people write it.
func TrimFolder(p string) string {
	p = strings.TrimPrefix(p, "/")
	return strings.TrimSuffix(p, "/")
}
