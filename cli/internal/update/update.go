// Package update is the CLI's self-update (the CLI design, 8.4): it reads a channel's pointer and the release
// manifest from build.caitlyn.ai/releases/cli, verifies the manifest's minisign signature against the key built into the
// binary, downloads the platform's archive beside the binary, checks its size and SHA-256, runs the new binary's
// `version --json`, and swaps it in atomically, keeping the old one as caitlyn.previous for --rollback. Installs a
// package manager owns are left to it.
package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"aead.dev/minisign"
)

// BaseURL is where releases are published (8.4's release layout). CAITLYN_UPDATE_URL overrides it (tests).
var BaseURL = "https://build.caitlyn.ai/releases/cli/"

// BaseURLEnv overrides BaseURL.
const BaseURLEnv = "CAITLYN_UPDATE_URL"

// PublicKey is the minisign public key release manifests are signed with.
//
// REPLACE AT RELEASE: this is a placeholder, not a key. Until the release set-up (question 22) creates the real key
// pair and puts its public half here (or the release build sets it with
// -ldflags "-X github.com/caitlyn-ai/sdk/cli/internal/update.PublicKey=RW…"), every manifest fails verification,
// so `caitlyn update` refuses every release. That is the safe failure.
var PublicKey = "REPLACE_AT_RELEASE_minisign_public_key"

// CosignPublicKey is the release signing key's public half (cosign, held in AWS KMS), as one line of base64 DER, set
// at build time like PublicKey (-X …/update.CosignPublicKey=MFkw…). Releases sign their checksums and container image
// with it; `caitlyn version --json` shows it, so it can be compared with https://build.caitlyn.ai/releases/cli/cosign.pub.
var CosignPublicKey = "REPLACE_AT_RELEASE_cosign_public_key"

// Channels are the release channels.
var Channels = []string{"stable", "beta"}

// Limits on what is downloaded before it is verified.
const (
	maxManifestBytes = 1 << 20
	maxArchiveBytes  = 512 << 20
)

// ChannelPointer is channels/<channel>.json.
type ChannelPointer struct {
	Version  string `json:"version"`
	Manifest string `json:"manifest"`
}

// Platform is one archive in a release.
type Platform struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is <version>/manifest.json.
type Manifest struct {
	Version   string     `json:"version"`
	Channel   string     `json:"channel"`
	Date      string     `json:"date"`
	Platforms []Platform `json:"platforms"`
}

// Release is a verified manifest, and the archive for this platform in it.
type Release struct {
	Manifest Manifest
	Platform Platform
	// ManifestURL is where the manifest came from; the archive's URL is resolved against it.
	ManifestURL string
}

// Error is an update failure, with a stable code for the CLI's error output.
type Error struct {
	Code string
	Msg  string
	Err  error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Msg + ": " + e.Err.Error()
	}
	return e.Msg
}

func (e *Error) Unwrap() error { return e.Err }

func fail(code, msg string, err error) error { return &Error{Code: code, Msg: msg, Err: err} }

// The failure codes.
const (
	CodeFetch        = "UPDATE_FETCH_FAILED"
	CodeSignature    = "UPDATE_SIGNATURE_INVALID"
	CodeManifest     = "UPDATE_MANIFEST_INVALID"
	CodeNoPlatform   = "UPDATE_NO_PLATFORM"
	CodeChecksum     = "UPDATE_CHECKSUM_MISMATCH"
	CodeUnpack       = "UPDATE_UNPACK_FAILED"
	CodeStartCheck   = "UPDATE_START_CHECK_FAILED"
	CodeSwap         = "UPDATE_SWAP_FAILED"
	CodeNoPrevious   = "UPDATE_NO_PREVIOUS"
	CodeRolledBack   = "UPDATE_ROLLED_BACK"
	CodeNotPermitted = "UPDATE_NOT_PERMITTED"
)

// Updater applies updates to one binary.
type Updater struct {
	BaseURL   string
	PublicKey string
	Client    *http.Client
	// Exe is the binary to replace (the running one).
	Exe string
	// GOOS and GOARCH choose the archive.
	GOOS, GOARCH string
	// Windows uses the rename-aside swap (a running .exe can't be replaced). Default: GOOS is windows.
	Windows bool
	// StartCheck runs the new binary's `version --json` and returns the version it reports.
	StartCheck func(ctx context.Context, binary string) (string, error)
}

// New is an Updater for the running binary.
func New(base, key string) (*Updater, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return &Updater{BaseURL: base, PublicKey: key, Exe: exe, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH, Windows: runtime.GOOS == "windows"}, nil
}

func (u *Updater) client() *http.Client {
	if u.Client != nil {
		return u.Client
	}
	return &http.Client{Timeout: 5 * time.Minute}
}

func (u *Updater) resolve(ref string, against string) (string, error) {
	base, err := url.Parse(against)
	if err != nil {
		return "", err
	}
	r, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	out := base.ResolveReference(r)
	if out.Scheme != "https" && !(out.Scheme == "http" && (out.Hostname() == "127.0.0.1" || out.Hostname() == "localhost" || out.Hostname() == "::1")) {
		return "", fmt.Errorf("%s is not an https URL", out)
	}
	return out.String(), nil
}

func (u *Updater) base() string {
	b := u.BaseURL
	if b == "" {
		b = BaseURL
	}
	if !strings.HasSuffix(b, "/") {
		b += "/"
	}
	return b
}

func (u *Updater) get(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", rawURL, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", rawURL, limit)
	}
	return b, nil
}

// Pointer reads a channel's pointer. It is not signed: it only names a version, and the manifest it leads to is
// verified before anything is trusted.
func (u *Updater) Pointer(ctx context.Context, channel string) (ChannelPointer, error) {
	var p ChannelPointer
	if !validChannel(channel) {
		return p, fail(CodeManifest, fmt.Sprintf("%q is not a channel (stable or beta)", channel), nil)
	}
	ref, err := u.resolve("channels/"+channel+".json", u.base())
	if err != nil {
		return p, fail(CodeFetch, "the release address is not usable", err)
	}
	b, err := u.get(ctx, ref, 64<<10)
	if err != nil {
		return p, fail(CodeFetch, "the "+channel+" channel couldn't be read", err)
	}
	if err := json.Unmarshal(b, &p); err != nil || p.Version == "" {
		return p, fail(CodeManifest, "the "+channel+" channel's pointer is not valid", err)
	}
	if _, err := ParseVersion(p.Version); err != nil {
		return p, fail(CodeManifest, "the "+channel+" channel names no valid version", err)
	}
	return p, nil
}

func validChannel(c string) bool {
	for _, ch := range Channels {
		if c == ch {
			return true
		}
	}
	return false
}

// Latest is the newest release on a channel, verified.
func (u *Updater) Latest(ctx context.Context, channel string) (*Release, error) {
	p, err := u.Pointer(ctx, channel)
	if err != nil {
		return nil, err
	}
	ref := p.Manifest
	if ref == "" {
		ref = p.Version + "/manifest.json"
	}
	rel, err := u.release(ctx, ref)
	if err != nil {
		return nil, err
	}
	if rel.Manifest.Version != p.Version {
		return nil, fail(CodeManifest, fmt.Sprintf("the channel names %s but its manifest is for %s", p.Version, rel.Manifest.Version), nil)
	}
	// The pointer isn't signed, the manifest is: a stable pointer must lead to a stable manifest. A beta channel may
	// point at a stable release (a release is on both).
	if mc := rel.Manifest.Channel; mc != channel && !(channel == "beta" && mc == "stable") {
		return nil, fail(CodeManifest, fmt.Sprintf("the %s channel names a %s release (%s)", channel, mc, rel.Manifest.Version), nil)
	}
	return rel, nil
}

// Version is one release by version, verified (--version).
func (u *Updater) Version(ctx context.Context, version string) (*Release, error) {
	v, err := ParseVersion(version)
	if err != nil {
		return nil, fail(CodeManifest, err.Error(), nil)
	}
	rel, err := u.release(ctx, v.String()+"/manifest.json")
	if err != nil {
		return nil, err
	}
	if rel.Manifest.Version != v.String() {
		return nil, fail(CodeManifest, fmt.Sprintf("the manifest for %s says it is %s", v, rel.Manifest.Version), nil)
	}
	return rel, nil
}

// Verify checks a manifest's minisign signature against the public key.
func Verify(publicKey string, manifest, signature []byte) error {
	var pk minisign.PublicKey
	if err := pk.UnmarshalText([]byte(strings.TrimSpace(publicKey))); err != nil {
		return fail(CodeSignature, "the built-in public key is not usable, so no release can be verified", err)
	}
	if len(bytes.TrimSpace(signature)) == 0 {
		return fail(CodeSignature, "the manifest has no signature", nil)
	}
	if !minisign.Verify(pk, manifest, signature) {
		return fail(CodeSignature, "the manifest's signature doesn't match the built-in public key", nil)
	}
	return nil
}

func (u *Updater) release(ctx context.Context, ref string) (*Release, error) {
	mURL, err := u.resolve(ref, u.base())
	if err != nil {
		return nil, fail(CodeFetch, "the manifest's address is not usable", err)
	}
	body, err := u.get(ctx, mURL, maxManifestBytes)
	if err != nil {
		return nil, fail(CodeFetch, "the release manifest couldn't be read", err)
	}
	sig, err := u.get(ctx, mURL+".minisig", 64<<10)
	if err != nil {
		return nil, fail(CodeSignature, "the manifest's signature couldn't be read, so the release isn't trusted", err)
	}
	key := u.PublicKey
	if key == "" {
		key = PublicKey
	}
	if err := Verify(key, body, sig); err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fail(CodeManifest, "the manifest is not valid", err)
	}
	if _, err := ParseVersion(m.Version); err != nil {
		return nil, fail(CodeManifest, "the manifest names no valid version", err)
	}
	for _, p := range m.Platforms {
		if p.OS == u.GOOS && p.Arch == u.GOARCH {
			if p.Size <= 0 || p.Size > maxArchiveBytes || len(p.SHA256) != 64 {
				return nil, fail(CodeManifest, "the manifest's entry for "+u.GOOS+"/"+u.GOARCH+" is incomplete", nil)
			}
			return &Release{Manifest: m, Platform: p, ManifestURL: mURL}, nil
		}
	}
	return nil, fail(CodeNoPlatform, fmt.Sprintf("release %s has no build for %s/%s", m.Version, u.GOOS, u.GOARCH), nil)
}

// binName is the binary's name inside an archive.
func (u *Updater) binName() string {
	if u.GOOS == "windows" {
		return "caitlyn.exe"
	}
	return "caitlyn"
}

// PreviousPath is where the replaced binary is kept: caitlyn.previous (caitlyn.previous.exe on Windows).
func PreviousPath(exe string) string {
	if strings.HasSuffix(strings.ToLower(exe), ".exe") {
		return strings.TrimSuffix(exe, filepath.Ext(exe)) + ".previous.exe"
	}
	return exe + ".previous"
}

// OldPath is where Windows moves the running binary aside; the next run deletes it.
func OldPath(exe string) string { return exe + ".old" }

// Apply installs rel over the binary. Every failure leaves the old binary in place.
func (u *Updater) Apply(ctx context.Context, rel *Release) error {
	dir := filepath.Dir(u.Exe)
	archiveURL, err := u.resolve(rel.Platform.URL, rel.ManifestURL)
	if err != nil {
		return fail(CodeManifest, "the archive's address is not usable", err)
	}
	// 1. Download beside the binary, so the final rename stays on one filesystem.
	tmp, err := os.CreateTemp(dir, ".caitlyn-download-*")
	if err != nil {
		return fail(CodeNotPermitted, "can't write beside "+u.Exe+" (is it installed somewhere you can't write?)", err)
	}
	defer os.Remove(tmp.Name())
	if err := u.download(ctx, archiveURL, tmp, rel.Platform); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return fail(CodeFetch, "the download couldn't be saved", err)
	}
	// 2. Unpack the binary.
	newBin, err := u.unpack(tmp.Name(), dir, rel.Platform.URL)
	if err != nil {
		return err
	}
	defer os.Remove(newBin)
	// 3. It must start and say it is the promised version.
	if err := u.startCheck(ctx, newBin, rel.Manifest.Version); err != nil {
		return err
	}
	// 4. Swap.
	if err := u.swap(newBin); err != nil {
		return err
	}
	// 5. Check the installed binary too; restore the previous one if it doesn't start.
	if err := u.startCheck(ctx, u.Exe, rel.Manifest.Version); err != nil {
		if rerr := u.restore(); rerr != nil {
			return fail(CodeStartCheck, "the new binary doesn't start, and restoring the previous one failed too", errors.Join(err, rerr))
		}
		return fail(CodeRolledBack, "the new binary didn't start once installed, so the previous one was restored", err)
	}
	return nil
}

func (u *Updater) download(ctx context.Context, rawURL string, w io.Writer, p Platform) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fail(CodeFetch, "the archive couldn't be requested", err)
	}
	resp, err := u.client().Do(req)
	if err != nil {
		return fail(CodeFetch, "the archive couldn't be downloaded", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fail(CodeFetch, "the archive couldn't be downloaded", fmt.Errorf("%s answered %s", rawURL, resp.Status))
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(resp.Body, p.Size+1))
	if err != nil {
		return fail(CodeFetch, "the archive couldn't be downloaded", err)
	}
	if n != p.Size {
		return fail(CodeChecksum, fmt.Sprintf("the archive is %d bytes, but the manifest says %d", n, p.Size), nil)
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, p.SHA256) {
		return fail(CodeChecksum, "the archive's SHA-256 doesn't match the manifest's", fmt.Errorf("got %s, want %s", got, p.SHA256))
	}
	return nil
}

func (u *Updater) unpack(archive, dir, name string) (string, error) {
	out, err := os.CreateTemp(dir, ".caitlyn-new-*")
	if err != nil {
		return "", fail(CodeUnpack, "the new binary couldn't be written", err)
	}
	ok := false
	defer func() {
		if !ok {
			out.Close()
			os.Remove(out.Name())
		}
	}()
	want := u.binName()
	found := false
	if strings.HasSuffix(strings.ToLower(path.Base(name)), ".zip") {
		zr, err := zip.OpenReader(archive)
		if err != nil {
			return "", fail(CodeUnpack, "the archive is not a zip file", err)
		}
		defer zr.Close()
		for _, f := range zr.File {
			if path.Base(f.Name) != want || f.FileInfo().IsDir() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return "", fail(CodeUnpack, "the binary couldn't be read from the archive", err)
			}
			_, err = io.Copy(out, io.LimitReader(rc, maxArchiveBytes))
			rc.Close()
			if err != nil {
				return "", fail(CodeUnpack, "the binary couldn't be unpacked", err)
			}
			found = true
			break
		}
	} else {
		f, err := os.Open(archive)
		if err != nil {
			return "", fail(CodeUnpack, "the archive couldn't be opened", err)
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return "", fail(CodeUnpack, "the archive is not a .tar.gz file", err)
		}
		tr := tar.NewReader(gz)
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return "", fail(CodeUnpack, "the archive is damaged", err)
			}
			if hdr.Typeflag != tar.TypeReg || path.Base(hdr.Name) != want {
				continue
			}
			if _, err := io.Copy(out, io.LimitReader(tr, maxArchiveBytes)); err != nil {
				return "", fail(CodeUnpack, "the binary couldn't be unpacked", err)
			}
			found = true
			break
		}
	}
	if !found {
		return "", fail(CodeUnpack, "the archive has no "+want, nil)
	}
	if err := out.Chmod(0o755); err != nil && runtime.GOOS != "windows" {
		return "", fail(CodeUnpack, "the new binary couldn't be made executable", err)
	}
	if err := out.Close(); err != nil {
		return "", fail(CodeUnpack, "the new binary couldn't be written", err)
	}
	ok = true
	return out.Name(), nil
}

func (u *Updater) startCheck(ctx context.Context, bin, want string) error {
	check := u.StartCheck
	if check == nil {
		check = RunVersion
	}
	got, err := check(ctx, bin)
	if err != nil {
		return fail(CodeStartCheck, "the new binary didn't start, so it wasn't installed", err)
	}
	if got != want {
		return fail(CodeStartCheck, fmt.Sprintf("the new binary says it is %s, not %s, so it wasn't installed", got, want), nil)
	}
	return nil
}

// RunVersion runs `<binary> version --json` in a clean configuration, with usage data for Caitlyn and the update notice off,
// and returns the version it reports.
func RunVersion(ctx context.Context, binary string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cfgDir, err := os.MkdirTemp("", "caitlyn-start-check-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(cfgDir)
	c := exec.CommandContext(ctx, binary, "version", "--json")
	c.Env = append(os.Environ(), "CAITLYN_CONFIG_DIR="+cfgDir, "CAITLYN_TELEMETRY=0", "CAITLYN_NO_UPDATE_NOTIFIER=1", "CAITLYN_NO_INPUT=1", "CAITLYN_CI=off")
	c.Dir = cfgDir // so no project file in the working directory is read
	var stderr bytes.Buffer
	c.Stderr = &stderr
	out, err := c.Output()
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	var v struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(out, &v); err != nil || v.Version == "" {
		return "", fmt.Errorf("version --json printed no version")
	}
	return v.Version, nil
}

// swap puts newBin in place of the binary and keeps the old one as caitlyn.previous.
func (u *Updater) swap(newBin string) error {
	prev := PreviousPath(u.Exe)
	if u.Windows {
		// A running .exe can't be replaced or deleted, but it can be renamed: copy it to previous for --rollback,
		// rename it aside (deleted on the next run), and move the new one in.
		if err := copyFile(u.Exe, prev); err != nil {
			return fail(CodeSwap, "the current binary couldn't be kept as "+filepath.Base(prev), err)
		}
		old := OldPath(u.Exe)
		_ = os.Remove(old)
		if err := os.Rename(u.Exe, old); err != nil {
			return fail(CodeSwap, "the current binary couldn't be moved aside", err)
		}
		if err := os.Rename(newBin, u.Exe); err != nil {
			_ = os.Rename(old, u.Exe)
			return fail(CodeSwap, "the new binary couldn't be moved into place", err)
		}
		return nil
	}
	// Keep the current binary as previous with a second link (or a copy), then rename the new one over it: a rename
	// replaces atomically, so there is never a moment with no caitlyn at the path.
	_ = os.Remove(prev)
	if err := os.Link(u.Exe, prev); err != nil {
		if cerr := copyFile(u.Exe, prev); cerr != nil {
			return fail(CodeSwap, "the current binary couldn't be kept as "+filepath.Base(prev), errors.Join(err, cerr))
		}
	}
	if err := os.Rename(newBin, u.Exe); err != nil {
		return fail(CodeSwap, "the new binary couldn't be moved into place; the installed one is unchanged", err)
	}
	return nil
}

// restore undoes a swap whose new binary failed its check: previous goes back into place, and the failed binary is
// deleted rather than kept as previous, so a later --rollback can't reinstall it.
func (u *Updater) restore() error {
	prev := PreviousPath(u.Exe)
	// A second link (or a copy) of previous, renamed over the failed binary: a rename replaces atomically, so there
	// is never a moment with no caitlyn at the path, and the failed binary is gone with it
	tmp := u.Exe + ".restore"
	_ = os.Remove(tmp)
	if err := os.Link(prev, tmp); err != nil {
		if cerr := copyFile(prev, tmp); cerr != nil {
			return errors.Join(err, cerr)
		}
	}
	if err := os.Rename(tmp, u.Exe); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Rollback puts caitlyn.previous back, and keeps the binary it replaces as the new previous, so a rollback can be
// undone the same way.
func (u *Updater) Rollback() error {
	prev := PreviousPath(u.Exe)
	if _, err := os.Stat(prev); err != nil {
		return fail(CodeNoPrevious, "there is no previous version to roll back to ("+filepath.Base(prev)+" is missing)", nil)
	}
	aside := u.Exe + ".rollback"
	_ = os.Remove(aside)
	if u.Windows {
		// The .old name may still hold the binary an update moved aside, in use until this process exits.
		aside = u.Exe + ".rollback.old"
		_ = os.Remove(aside)
	}
	if !u.Windows {
		// Keep the current binary aside with a second link, then rename previous over it: atomic, as swap is
		if err := os.Link(u.Exe, aside); err != nil {
			if cerr := copyFile(u.Exe, aside); cerr != nil {
				return fail(CodeSwap, "the current binary couldn't be kept", errors.Join(err, cerr))
			}
		}
		if err := os.Rename(prev, u.Exe); err != nil {
			_ = os.Remove(aside)
			return fail(CodeSwap, "the previous binary couldn't be moved into place", err)
		}
		_ = os.Rename(aside, prev)
		return nil
	}
	if err := os.Rename(u.Exe, aside); err != nil {
		return fail(CodeSwap, "the current binary couldn't be moved aside", err)
	}
	if err := os.Rename(prev, u.Exe); err != nil {
		_ = os.Rename(aside, u.Exe)
		return fail(CodeSwap, "the previous binary couldn't be moved into place", err)
	}
	if u.Windows {
		// The running binary is still in use: copy it to previous, and leave the moved-aside file for the next run.
		_ = copyFile(aside, prev)
		return nil
	}
	_ = os.Rename(aside, prev)
	return nil
}

// CleanupOld deletes the binaries a Windows update or rollback moved aside, on the next run.
func CleanupOld(exe string) {
	_ = os.Remove(OldPath(exe))
	_ = os.Remove(exe + ".rollback.old")
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	tmp := to + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, st.Mode().Perm()|0o700)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, to)
}
