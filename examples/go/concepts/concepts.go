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

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

const conversationID = "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47"

// Errors shows how to tell the errors apart.
func Errors(ctx context.Context, client *caitlyn.Client) {
	// #region errors
	_, err := client.Agent("GHT7YRWXPL").Version("v99").Get(ctx)
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
	stream, err := client.Conversation(conversationID).Send(ctx, "How much annual leave do part-time staff get?")
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
	stream, err := client.Conversation(conversationID).Send(ctx, "Summarise the leave policy.")
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

// PaginationItems lists every document in a folder, one at a time.
func PaginationItems(ctx context.Context, client *caitlyn.Client) error {
	// #region pagination-items
	// Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
	documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
	input := &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](100)}
	for document, err := range documents.List(ctx, input) {
		if err != nil {
			return err
		}
		fmt.Println(document.Name, document.Status)
		if document.Name == "leave-policy.pdf" {
			break // stops here: no further page is requested
		}
	}
	// #endregion
	return nil
}

// PaginationPages reads every page of a folder's documents in turn.
func PaginationPages(ctx context.Context, client *caitlyn.Client) error {
	// #region pagination-pages
	// Every page in turn, each with its Items and NextCursor: for work done a batch at a time
	documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
	input := &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](100)}
	for page, err := range documents.ListPages(ctx, input) {
		if err != nil {
			return err
		}
		fmt.Printf("%d documents; more to come: %v\n", len(page.Items), page.HasNextPage())
	}
	// #endregion
	return nil
}

// PaginationPage reads one page of a folder's documents.
func PaginationPage(ctx context.Context, client *caitlyn.Client) error {
	// #region pagination-page
	// One page, in exactly one request: the first 25 documents
	documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
	page, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](25)})
	if err != nil {
		return err
	}
	for _, document := range page.Items {
		fmt.Println(document.Name)
	}
	fmt.Println(page.NextCursor) // nil on the last page
	// #endregion
	return nil
}

// PaginationNextPage shows a page and a Next button, and reads the next page when it is clicked.
func PaginationNextPage(ctx context.Context, client *caitlyn.Client) error {
	render := func(items []caitlyn.Document) { fmt.Println(len(items)) }
	nextButtonHidden := true
	// #region pagination-has-next-page
	// Show the first page, and a "Next" button only when another page follows: knowing that takes no request
	documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
	page, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](25)})
	if err != nil {
		return err
	}
	render(page.Items)
	nextButtonHidden = !page.HasNextPage()
	// #endregion
	// #region pagination-next-page
	// The "Next" button's click handler: one request, for the page after the one shown
	onNextClick := func() error {
		next, err := page.NextPage(ctx) // nil, nil after the last page
		if err != nil || next == nil {
			return err
		}
		page = next
		render(page.Items)
		nextButtonHidden = !page.HasNextPage()
		return nil
	}
	// #endregion
	fmt.Println(nextButtonHidden)
	return onNextClick()
}

// PaginationCursor carries on from a saved cursor.
func PaginationCursor(ctx context.Context, client *caitlyn.Client, cursor *string) error {
	// #region pagination-cursor
	// Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
	documents := client.KnowledgeBase("KB4T7YQ2WL").Documents
	page, err := documents.ListPage(ctx, &caitlyn.ListDocumentsInput{Folder: caitlyn.Ptr("/policies/"), Limit: caitlyn.Ptr[int32](25), Cursor: cursor})
	if err != nil {
		return err
	}
	fmt.Println(len(page.Items), page.NextCursor) // save page.NextCursor to carry on from here next time
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
