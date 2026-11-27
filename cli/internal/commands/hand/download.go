package hand

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// documents download saves the document's bytes: GetDocumentDownload only gives a short-lived address, and -o is the
// output format everywhere, so `-o file.pdf` used to be refused as a format. --url-only (and -o json, yaml or jsonl
// without --out) keeps the address and when it expires. Its help is in naming.yaml (commands).
func init() {
	gen.Extend("knowledge-bases documents download", func(c *gen.Command) {
		addressOnly := c.Cobra.RunE
		// Its own examples, in help and in the docs (in place of the model's, which only get the address)
		c.Cobra.Example = "  # Save the current version, under its own name\n" +
			"  caitlyn knowledge-bases documents download doc-3b7f9e21 --kb KB4T7YQ2WL\n" +
			"  # Save it as another file\n" +
			"  caitlyn knowledge-bases documents download doc-3b7f9e21 --kb KB4T7YQ2WL --out ./leave-policy-copy.pdf\n" +
			"  # Pipe it to another program\n" +
			"  caitlyn knowledge-bases documents download doc-3b7f9e21 --kb KB4T7YQ2WL --out - | pdftotext - -\n" +
			"  # Only the address, for a script\n" +
			"  caitlyn knowledge-bases documents download doc-3b7f9e21 --kb KB4T7YQ2WL --url-only -o json"
		if c.Cobra.Annotations == nil {
			c.Cobra.Annotations = map[string]string{}
		}
		c.Cobra.Annotations[gen.AnnotationOwnExamples] = "true"
		fl := c.Cobra.Flags()
		fl.StringP("out", "O", "", "The file to save it to, or - for stdout (default: the document's name, in the current folder)")
		fl.Bool("url-only", false, "Print the address of the bytes and when it expires, and save nothing")
		fl.Bool("force", false, "Overwrite the file if it exists")
		c.Cobra.RunE = func(cmd *cobra.Command, args []string) error {
			out, _ := cmd.Flags().GetString("out")
			urlOnly, _ := cmd.Flags().GetBool("url-only")
			format := c.F.Globals.Output
			if format != "" && !knownFormat(format) {
				e := cmdutil.Usagef("-o is the output format (table, json, jsonl, yaml or text), not a file: save it with --out %s.", format)
				e.Hint = &cmdutil.Hint{Missing: []string{"--out"}}
				return e
			}
			if urlOnly || (out == "" && (format == "json" || format == "jsonl" || format == "yaml")) {
				return addressOnly(cmd, args)
			}
			return downloadDocument(cmd.Context(), c, cmd, args, out)
		}
	})
}

func knownFormat(f string) bool {
	switch f {
	case "table", "json", "jsonl", "yaml", "text":
		return true
	}
	return false
}

func downloadDocument(ctx context.Context, c *gen.Command, cmd *cobra.Command, args []string, out string) error {
	r := c.NewRun(c.F, cmd, args)
	return r.Hint(func() error {
		if err := r.Prepare(); err != nil {
			return err
		}
		f := r.F
		kb, id := r.IDs["knowledgeBaseId"], r.IDs["documentId"]
		force, _ := cmd.Flags().GetBool("force")
		if f.Globals.DryRun != "" {
			return gen.DryRun(f, c.Op, r.In)
		}
		_, tc, err := f.Clients(ctx)
		if err != nil {
			return err
		}
		doc := tc.KnowledgeBase(kb).Document(id)
		if out == "" {
			d, err := doc.Get(ctx)
			if err != nil {
				return err
			}
			out = safeName(d.Name, id)
		}
		// A relative path is the current folder's (the factory's, under test)
		if out != "-" && !filepath.IsAbs(out) && f.WorkDir != "" {
			out = filepath.Join(f.WorkDir, out)
		}
		if out != "-" && !force {
			if _, err := os.Stat(out); err == nil {
				e := cmdutil.Usagef("%s already exists: name another file with --out, or replace it with --force.", out)
				e.Hint = &cmdutil.Hint{Missing: []string{"--force"}}
				return e
			}
		}
		in := &caitlyn.GetDocumentDownloadInput{}
		if v, ok := r.In.Values["version"].(string); ok && v != "" {
			in.Version = &v
		}
		dl, err := doc.Download(ctx, in)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, dl.URL, nil)
		if err != nil {
			return err
		}
		hc := http.DefaultClient
		if f.HTTPClient != nil {
			hc = f.HTTPClient
		}
		res, err := hc.Do(req)
		if err != nil {
			return &cmdutil.Error{Exit: exitcode.Connection, Code: "CONNECTION_FAILED", Title: "The document's bytes could not be fetched.", Cause: err}
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return &cmdutil.Error{Exit: exitcode.Failed, Code: "DOWNLOAD_FAILED", Title: fmt.Sprintf("The document's bytes could not be fetched (HTTP %d).", res.StatusCode),
				Detail: "Nothing was saved. Try again: each download gets a new address."}
		}
		if out == "-" {
			if f.IO.IsStdoutTTY() && !textual(res.Header.Get("Content-Type")) {
				e := cmdutil.Usagef("Not writing %s to a terminal: it isn't text. Save it with --out <file>, or pipe it.", res.Header.Get("Content-Type"))
				e.Hint = &cmdutil.Hint{Missing: []string{"--out <file>"}}
				return e
			}
			_, err := io.Copy(f.IO.Out, res.Body)
			return err
		}
		n, err := saveAtomically(out, res.Body)
		if err != nil {
			return err
		}
		p, err := output.New(f, r.UI)
		if err != nil {
			return err
		}
		if p.Human {
			r.UI.Successf("Saved %s (%d bytes).", out, n)
			return nil
		}
		return p.Value(map[string]any{"path": out, "byteSize": n}, "")
	}())
}

// safeName is the document's own name as a file in the current folder: only its last part, never a path.
func safeName(name, id string) string {
	base := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if base == "." || base == "/" || base == ".." || base == "" {
		return id
	}
	return base
}

func textual(contentType string) bool {
	ct := strings.ToLower(contentType)
	return strings.HasPrefix(ct, "text/") || strings.Contains(ct, "json") || strings.Contains(ct, "xml") || strings.Contains(ct, "markdown")
}

// saveAtomically writes the bytes beside the file and renames them into place, so a failed download leaves nothing.
func saveAtomically(path string, r io.Reader) (int64, error) {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".part-*")
	if err != nil {
		return 0, cmdutil.Usagef("%s can't be written: %v", path, err)
	}
	n, err := io.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return 0, &cmdutil.Error{Exit: exitcode.Failed, Code: "DOWNLOAD_FAILED", Title: "The download didn't finish, so nothing was saved.", Cause: err}
	}
	return n, nil
}
