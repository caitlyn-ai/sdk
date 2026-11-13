// Package concepts holds the code on the developer docs' Errors, Retries, Streaming, Pagination and Telemetry
// pages (docs/*.md), one region each. scripts/test-go.sh builds and vets it against the SDK.
package concepts

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	caitlyn "github.com/caitlyn-ai/caitlyn-go"
)

const conversationID = "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47"

// Errors shows how to tell the errors apart.
func Errors(ctx context.Context, client *caitlyn.Client) {
	// #region errors
	_, err := client.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: "GHT7YRWXPL", Version: "v99"})
	var notFound *caitlyn.NotFoundError
	var invalid *caitlyn.ValidationError
	var noResponse *caitlyn.ConnectionError
	var apiErr *caitlyn.Error
	switch {
	case err == nil:
	case errors.As(err, &notFound):
		fmt.Println("No such version")
	case errors.As(err, &invalid):
		for _, e := range invalid.Errors {
			fmt.Println(e.Pointer, e.Code, e.Detail)
		}
	case errors.As(err, &noResponse):
		fmt.Println("No response from Caitlyn:", noResponse.Cause) // after the SDK's retries
	case errors.As(err, &apiErr):
		// Any other status. Code is the stable product code; quote RequestID to support.
		fmt.Println(apiErr.Status, apiErr.Code, apiErr.Detail, apiErr.RequestID)
		if apiErr.RawBody != "" && apiErr.Title == "" {
			fmt.Println(apiErr.RawBody) // not a Caitlyn error body: a proxy's page, say
		}
	default:
		log.Fatal(err)
	}
	// #endregion
}

// Retries creates a client that tries harder.
func Retries() (*caitlyn.Client, error) {
	// #region retries
	patient, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")),
		caitlyn.WithMaxAttempts(5),               // the first attempt included; default 3
		caitlyn.WithMaxRetryDelay(2*time.Minute), // the longest Retry-After to wait for; default 60 s
	)
	// #endregion
	return patient, err
}

// RetryBudget creates a client with a larger retry budget.
func RetryBudget() (*caitlyn.Client, error) {
	// #region retry-budget
	batch, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")),
		caitlyn.WithRetryBudget(2000), // retry tokens shared by every call on this client; default 500, and 0 turns retries off
	)
	// #endregion
	return batch, err
}

// Streaming streams an answer.
func Streaming(ctx context.Context, client *caitlyn.Client) error {
	// #region streaming
	stream, err := client.Conversations.Send(ctx, conversationID, &caitlyn.SendMessageInput{
		Message: "How much annual leave do part-time staff get?",
	})
	if err != nil {
		return err
	}
	defer stream.Close()
	for event, err := range stream.Events() {
		if err != nil {
			return err
		}
		switch e := event.(type) {
		case *caitlyn.TextDelta:
			fmt.Print(e.Delta)
		case *caitlyn.CitationAdded:
			fmt.Printf("\n[%d] %s\n", e.Citation.Number, *e.Citation.DocumentName)
		}
	}
	answer, err := stream.FinalMessage() // the complete message, with its citations
	if err != nil {
		return err
	}
	fmt.Println(answer.ID, stream.RequestID())
	// #endregion
	return nil
}

// Cancelling gives up on an answer after 30 seconds.
func Cancelling(client *caitlyn.Client) error {
	// #region cancelling
	// Give up after 30 seconds: the connection closes and the loop returns the context's error
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	stream, err := client.Conversations.Send(ctx, conversationID, &caitlyn.SendMessageInput{Message: "Summarise the leave policy."})
	if err != nil {
		return err
	}
	defer stream.Close()
	for event, err := range stream.Events() {
		if err != nil {
			return err
		}
		if delta, ok := event.(*caitlyn.TextDelta); ok {
			fmt.Print(delta.Delta)
		}
	}
	// #endregion
	return nil
}

// Pagination lists every document in a folder.
func Pagination(ctx context.Context, client *caitlyn.Client) error {
	// #region pagination
	// Every document in the folder: the next page is fetched as the loop reaches it
	input := &caitlyn.ListDocumentsInput{KnowledgeBaseID: "KB4T7YQ2WL", Folder: caitlyn.Ptr("hr/"), Limit: caitlyn.Ptr[int32](100)}
	for document, err := range client.Documents.List(ctx, input) {
		if err != nil {
			return err
		}
		fmt.Println(document.Name, document.Status)
	}

	// Or page by page
	for page, err := range client.Documents.ListPages(ctx, input) {
		if err != nil {
			return err
		}
		fmt.Println(len(page.Items), page.NextCursor)
	}
	// #endregion
	return nil
}

// Telemetry creates a client that sends trace context.
func Telemetry() (*caitlyn.Client, error) {
	// #region telemetry
	traced, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")),
		caitlyn.WithTracerProvider(otel.GetTracerProvider()), // default: the global provider
		caitlyn.WithPropagator(propagation.TraceContext{}),   // default: the global propagator
	)
	// #endregion
	return traced, err
}
