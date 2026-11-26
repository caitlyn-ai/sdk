package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/shellwords"
	"github.com/caitlyn-ai/sdk/go/core"
)

// openBrowser opens url with the configured browser command, else the operating system's default. Tests replace it.
var openBrowser = func(ctx context.Context, browser, url string) error {
	var cmd *exec.Cmd
	fields := shellwords.Split(browser)
	switch {
	case len(fields) > 0:
		// The browser setting is a command line, as BROWSER is, quotes honoured; the URL is its last argument
		cmd = exec.CommandContext(ctx, fields[0], append(fields[1:], url)...)
	case runtime.GOOS == "darwin":
		cmd = exec.CommandContext(ctx, "open", url)
	case runtime.GOOS == "windows":
		cmd = exec.CommandContext(ctx, "rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.CommandContext(ctx, "xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Don't wait for a browser that keeps running; reap it when it exits
	go func() { _ = cmd.Wait() }()
	return nil
}

// callbackResult is what the loopback redirect brought back.
type callbackResult struct {
	code string
	err  error
}

// loopback is the redirect listener for browser sign-in (RFC 8252 7.3): 127.0.0.1 on a random port, path /callback.
// It accepts one callback, checks its state, and closes.
type loopback struct {
	ln          net.Listener
	srv         *http.Server
	state       string
	RedirectURI string
	result      chan callbackResult
}

// listenLoopback starts the listener. Only 127.0.0.1: the server refuses localhost (17.4, item 2).
func listenLoopback(state string) (*loopback, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("a local port for the sign-in redirect could not be opened: %w", err)
	}
	l := &loopback{ln: ln, state: state, result: make(chan callbackResult, 1)}
	l.RedirectURI = fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", l.handle)
	l.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = l.srv.Serve(ln) }()
	return l, nil
}

func (l *loopback) handle(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var res callbackResult
	if subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(l.state)) != 1 {
		// Not this sign-in's redirect (a prefetch, another program, a page scanning ports): refuse it and keep
		// listening, so it can't end the sign-in
		http.Error(w, "This isn't the sign-in this listener is waiting for.", http.StatusBadRequest)
		return
	}
	switch {
	case q.Get("error") != "":
		res.err = &core.AuthError{Code: q.Get("error"), Message: q.Get("error_description")}
	case q.Get("code") == "":
		res.err = &core.AuthError{Code: "invalid_request", Message: "the sign-in redirect has no code"}
	default:
		res.code = q.Get("code")
	}
	select {
	case l.result <- res:
	default:
		// a second request after the first: the sign-in is already decided
		http.Error(w, "This sign-in has already finished.", http.StatusGone)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	title, body := "Signed in", "You're signed in to the Caitlyn CLI. You can close this tab and go back to your terminal."
	if res.err != nil {
		w.WriteHeader(http.StatusBadRequest)
		title, body = "Sign-in failed", "The Caitlyn CLI couldn't finish signing in: "+res.err.Error()+". Go back to your terminal for what to do next."
	}
	fmt.Fprintf(w, "<!doctype html><meta charset=utf-8><title>%s</title><body style=\"font-family:system-ui,sans-serif;max-width:32em;margin:4em auto\"><h1>%s</h1><p>%s</p>",
		html.EscapeString(title), html.EscapeString(title), html.EscapeString(body))
}

// wait returns the first callback's code, then closes the listener.
func (l *loopback) wait(ctx context.Context) (string, error) {
	defer l.close()
	select {
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			e := &cmdutil.Error{Exit: exitcode.Timeout, Code: "TIMEOUT", Title: "Sign-in wasn't approved in time.", Cause: ctx.Err()}
			e.AddNext("caitlyn auth login", "start again")
			return "", e
		}
		return "", ctx.Err()
	case r := <-l.result:
		return r.code, r.err
	}
}

// close stops the listener; the response to the callback is flushed first.
func (l *loopback) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = l.srv.Shutdown(ctx)
}
