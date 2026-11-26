package describe

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/output"
)

// MCPClient is an AI client `caitlyn mcp add` can connect to the workspace's MCP server (18.3).
type MCPClient struct {
	Name    string
	Aliases []string
	Label   string
	// File is the project's configuration file for the client, and Key the object in it that holds servers.
	File string
	Key  string
	// Entry is the server's entry for a URL.
	Entry func(url string) map[string]any
	// Command, when the client has one, adds the server from its own command line.
	Command func(url string) string
}

// MCPClients are the clients, by name.
var MCPClients = []MCPClient{
	{
		Name: "claude-code", Aliases: []string{"claude"}, Label: "Claude Code",
		File: ".mcp.json", Key: "mcpServers",
		Entry:   func(url string) map[string]any { return map[string]any{"type": "http", "url": url} },
		Command: func(url string) string { return "claude mcp add --transport http caitlyn " + url },
	},
	{
		Name: "cursor", Label: "Cursor",
		File: filepath.Join(".cursor", "mcp.json"), Key: "mcpServers",
		Entry: func(url string) map[string]any { return map[string]any{"url": url} },
	},
	{
		Name: "vscode", Aliases: []string{"vs-code", "code"}, Label: "VS Code",
		File: filepath.Join(".vscode", "mcp.json"), Key: "servers",
		Entry: func(url string) map[string]any { return map[string]any{"type": "http", "url": url} },
	},
}

// FindMCPClient finds a client by name or alias.
func FindMCPClient(name string) (MCPClient, bool) {
	name = strings.ToLower(name)
	for _, c := range MCPClients {
		if c.Name == name {
			return c, true
		}
		for _, a := range c.Aliases {
			if a == name {
				return c, true
			}
		}
	}
	return MCPClient{}, false
}

// MCPServerName is the server's name in every client's configuration.
const MCPServerName = "caitlyn"

// MCPAdded is what `caitlyn mcp add` prints as JSON.
type MCPAdded struct {
	Client    string         `json:"client"`
	Workspace string         `json:"workspace"`
	URL       string         `json:"url"`
	File      string         `json:"file"`
	Config    map[string]any `json:"config"`
	Command   string         `json:"command,omitempty"`
	// Written is true when --write wrote File; Changed is false when it already had this entry.
	Written bool `json:"written"`
	Changed bool `json:"changed"`
}

func newMCPCmd(f *cmdutil.Factory) *cobra.Command {
	group := &cobra.Command{
		Use:   "mcp",
		Short: "Connect an AI client to your workspace's MCP server",
		Args:  cobra.NoArgs,
		RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
	}
	var write bool
	var dir string
	names := make([]string, 0, len(MCPClients))
	for _, c := range MCPClients {
		names = append(names, c.Name)
	}
	add := &cobra.Command{
		Use:   "add <client>",
		Short: "Print, or write, the configuration that connects an AI client to the workspace's MCP server",
		Long: `Connects an AI client to the profile's workspace's MCP server, https://<workspace>/api/mcp, for conversational
work over the workspace from the client itself. The client is one of: ` + strings.Join(names, ", ") + `.

It prints the configuration, or with --write adds it to the client's file in this project (.mcp.json for Claude
Code, .cursor/mcp.json for Cursor, .vscode/mcp.json for VS Code), keeping every other server there. The client then
signs you in to the workspace with its own OAuth sign-in: the CLI never hands its token to another program.`,
		Args: cobra.ExactArgs(1),
		ValidArgsFunction: func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
			return names, cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			client, ok := FindMCPClient(args[0])
			if !ok {
				e := cmdutil.Usagef("%q is not a client caitlyn mcp add knows: use %s.", args[0], strings.Join(names, ", "))
				return e
			}
			ws, err := f.Workspace()
			if err != nil {
				return err
			}
			res, err := AddMCP(client, ws, resolve(f, dir), write)
			if err != nil {
				return err
			}
			return printMCP(f, client, res)
		},
	}
	add.Flags().BoolVar(&write, "write", false, "Add the server to the client's configuration file in this project")
	add.Flags().StringVar(&dir, "dir", ".", "The project folder whose configuration file --write changes")
	group.AddCommand(annotate(add, "write", "1,4"))
	return group
}

// AddMCP works out the client's entry for the workspace and, with write, merges it into the configuration file under
// dir. A file that is not JSON is refused rather than overwritten.
func AddMCP(client MCPClient, workspace, dir string, write bool) (*MCPAdded, error) {
	url := "https://" + workspace + "/api/mcp"
	entry := client.Entry(url)
	res := &MCPAdded{
		Client:    client.Name,
		Workspace: workspace,
		URL:       url,
		File:      client.File,
		Config:    map[string]any{client.Key: map[string]any{MCPServerName: entry}},
	}
	if client.Command != nil {
		res.Command = client.Command(url)
	}
	if !write {
		return res, nil
	}
	path := filepath.Join(dir, client.File)
	doc := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && len(bytes.TrimSpace(b)) > 0 {
		if err := json.Unmarshal(b, &doc); err != nil {
			e := cmdutil.Usagef("%s isn't JSON this command can safely change: %v", path, err)
			e.Detail = "Nothing was written. Add the entry printed without --write by hand."
			return nil, e
		}
	} else if err != nil && !os.IsNotExist(err) {
		return nil, cmdutil.FromError(err)
	}
	servers, _ := doc[client.Key].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	res.Changed = !jsonEqual(servers[MCPServerName], entry)
	servers[MCPServerName] = entry
	doc[client.Key] = servers
	res.File = path
	res.Written = true
	if !res.Changed {
		return res, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, cmdutil.FromError(err)
	}
	var buf bytes.Buffer
	if err := writeJSON(&buf, doc); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return nil, cmdutil.FromError(err)
	}
	return res, nil
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func printMCP(f *cmdutil.Factory, client MCPClient, res *MCPAdded) error {
	format, err := output.Resolve(f)
	if err != nil {
		return err
	}
	if format == output.JSON || format == output.JSONL || format == output.YAML || f.Globals.JQ != "" || f.Globals.Query != "" {
		if format == output.YAML && f.Globals.JQ == "" && f.Globals.Query == "" {
			return writeYAML(f.IO.Out, res)
		}
		return printData(f, res)
	}
	w := f.IO.Out
	switch {
	case res.Written && res.Changed:
		fmt.Fprintf(w, "Added the %s server (%s) to %s.\n", MCPServerName, res.URL, res.File)
	case res.Written:
		fmt.Fprintf(w, "%s already connects %s to %s. Nothing changed.\n", res.File, client.Label, res.URL)
	default:
		fmt.Fprintf(w, "To connect %s to %s:\n\n", client.Label, res.URL)
		if res.Command != "" {
			fmt.Fprintf(w, "  %s\n\nor add this to %s in your project:\n\n", res.Command, client.File)
		} else {
			fmt.Fprintf(w, "Add this to %s in your project:\n\n", client.File)
		}
		var buf bytes.Buffer
		_ = writeJSON(&buf, res.Config)
		for _, l := range strings.Split(strings.TrimRight(buf.String(), "\n"), "\n") {
			fmt.Fprintf(w, "  %s\n", l)
		}
		fmt.Fprintf(w, "\nOr run: caitlyn mcp add %s --write\n", client.Name)
	}
	fmt.Fprintf(w, "%s signs you in to %s itself the first time it connects.\n", client.Label, res.Workspace)
	return nil
}
