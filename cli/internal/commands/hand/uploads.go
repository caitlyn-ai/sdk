package hand

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
	caitlyn "github.com/caitlyn-ai/sdk/go"
	"github.com/caitlyn-ai/sdk/go/core"
)

// The @uploadTarget commands take a file as a positional argument (3.1): the SDK reserves an upload, sends the
// bytes, and makes the call with its identifier, which a generic command can't do.
func init() {
	gen.Extend("knowledge-bases documents create", func(c *gen.Command) {
		c.Cobra.Use = "create <file> [flags]"
		c.Cobra.Example = "  caitlyn kb documents create ./leave-policy.pdf --kb KB4T7YQ2WL --folder /policies/ --wait\n" + c.Cobra.Example
		c.Cobra.RunE = func(cmd *cobra.Command, args []string) error {
			return createDocument(cmd.Context(), c, cmd, args)
		}
	})
	gen.Extend("knowledge-bases documents replace", func(c *gen.Command) {
		c.Cobra.Use = "replace <document> <file> [flags]"
		c.Cobra.RunE = func(cmd *cobra.Command, args []string) error {
			return replaceDocument(cmd.Context(), c, cmd, args)
		}
	})
}

// fileArg is the file a command was given: a path, or - for stdin with --file-name.
func fileArg(r *gen.Run) (core.File, string, error) {
	v, _ := r.In.Values["__file"].(string)
	if v == "" {
		e := cmdutil.Usagef("Give the file: caitlyn %s <file>.", r.C.Spec.Name())
		e.Hint = &cmdutil.Hint{Missing: []string{"<file>"}}
		return nil, "", e
	}
	if v == "-" {
		return core.FileFromReader("stdin", r.F.IO.In), "stdin", nil
	}
	if _, err := os.Stat(v); err != nil {
		return nil, "", cmdutil.Usagef("%s can't be read: %v", v, err)
	}
	return caitlyn.Path(v), v, nil
}

// typedInput fills a typed SDK input from the generic one: body members by their wire names.
func typedInput(r *gen.Run, into any) error {
	body := map[string]any{}
	for _, m := range r.C.Op.Input {
		if v, ok := r.In.Values[m.Name]; ok && (m.Location == "body" || m.Location == "payload") {
			body[m.Wire] = v
		}
	}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, into)
}

func createDocument(ctx context.Context, c *gen.Command, cmd *cobra.Command, args []string) error {
	r := c.NewRun(c.F, cmd, args)
	return r.Hint(func() error {
		if err := r.Prepare(); err != nil {
			return err
		}
		file, name, err := fileArg(r)
		if err != nil {
			return err
		}
		f := r.F
		kb := r.IDs["knowledgeBaseId"]
		if f.Globals.DryRun != "" {
			fmt.Fprintf(f.IO.Out, "Upload %s, then:\n", name)
			r.In.Set("uploadId", "<the new upload's id>")
			return gen.DryRun(f, c.Op, r.In)
		}
		_, tc, err := f.Clients(ctx)
		if err != nil {
			return err
		}
		p, err := output.New(f, r.UI)
		if err != nil {
			return err
		}
		docs := tc.KnowledgeBase(kb).Documents
		if est, _ := cmd.Flags().GetBool("estimate"); est {
			res, err := docs.EstimateCreate(ctx, file)
			if err != nil {
				return err
			}
			return p.Value(res, "")
		}
		in := &caitlyn.CreateDocumentInput{}
		if err := typedInput(r, in); err != nil {
			return err
		}
		var opts []caitlyn.CallOption
		if r.In.IdempotencyKey != "" {
			opts = append(opts, caitlyn.WithIdempotencyKey(r.In.IdempotencyKey))
		}
		created, err := docs.Create(ctx, file, in, opts...)
		if err != nil {
			return err
		}
		thing, _ := json.Marshal(created)
		r.IDs["documentId"] = created.ID()
		if r.WantsWait() {
			r.UI.Infof("Uploaded %s. Waiting for it to be processed%s", name, r.UI.G.Ellipsis)
			return r.Wait(ctx, c.Spec.LongRunning, thing)
		}
		if p.Human {
			r.UI.Successf("Uploaded %s; it's being processed.", name)
			r.UI.Nextf("caitlyn kb documents wait %s --kb %s", created.ID(), kb)
			return nil
		}
		return p.Raw(thing, "")
	}())
}

func replaceDocument(ctx context.Context, c *gen.Command, cmd *cobra.Command, args []string) error {
	r := c.NewRun(c.F, cmd, args)
	return r.Hint(func() error {
		if err := r.Prepare(); err != nil {
			return err
		}
		file, name, err := fileArg(r)
		if err != nil {
			return err
		}
		f := r.F
		kb, doc := r.IDs["knowledgeBaseId"], r.IDs["documentId"]
		if f.Globals.DryRun != "" {
			fmt.Fprintf(f.IO.Out, "Upload %s, then:\n", name)
			r.In.Set("uploadId", "<the new upload's id>")
			return gen.DryRun(f, c.Op, r.In)
		}
		_, tc, err := f.Clients(ctx)
		if err != nil {
			return err
		}
		p, err := output.New(f, r.UI)
		if err != nil {
			return err
		}
		in := &caitlyn.CreateDocumentVersionInput{}
		if err := typedInput(r, in); err != nil {
			return err
		}
		var opts []caitlyn.CallOption
		if r.In.IfMatch != nil {
			opts = append(opts, caitlyn.WithIfMatch(*r.In.IfMatch))
		}
		started, err := tc.KnowledgeBase(kb).Document(doc).Replace(ctx, file, in, opts...)
		if err != nil {
			return err
		}
		thing, _ := json.Marshal(started)
		if r.WantsWait() {
			return r.Wait(ctx, c.Spec.LongRunning, thing)
		}
		if p.Human {
			r.UI.Successf("Uploaded %s as a new version of %s; it's being processed.", name, doc)
			r.UI.Nextf("caitlyn kb documents wait %s --kb %s", doc, kb)
			return nil
		}
		return p.Raw(thing, "")
	}())
}
