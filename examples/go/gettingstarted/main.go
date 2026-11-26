// The developer docs' Getting started page (docs/getting-started.md) shows the first-call region.
// scripts/test-go.sh builds and vets this module against the SDK.
package main

// #region first-call
import (
	"context"
	"fmt"
	"log"
	"os"

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

func main() {
	ctx := context.Background()
	client, err := caitlyn.NewClient("your-company.caitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")))
	if err != nil {
		log.Fatal(err)
	}

	// Read the draft of an agent: its configuration and its ETag
	draft, err := client.Agent("GHT7YRWXPL").Draft().Get(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if g := draft.Configuration.Guidance; g != nil && g.Instructions != nil {
		fmt.Println(*g.Instructions)
	}
}

// #endregion
