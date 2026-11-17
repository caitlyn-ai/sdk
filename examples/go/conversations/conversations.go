// Package conversations holds the developer docs' code for calling each operation, one region each. The live
// examples (examples/go/live, run by scripts/examples-live/go.sh) call these functions against a real Caitlyn
// server, so the code on the pages is known to work. scripts/test-go.sh builds and vets it against the SDK.
package conversations

import (
	"context"
	"errors"
	"fmt"

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// GetCaller checks who the client's credential belongs to.
func GetCaller(ctx context.Context, client *caitlyn.Client) (*caitlyn.Caller, error) {
	// #region get-caller
	caller, err := client.Me(ctx)
	if err != nil {
		return nil, err
	}
	fmt.Println(caller.DisplayName, caller.Credential, caller.Organisation.Name, caller.Scopes)
	// #endregion
	return caller, nil
}

// GetAgentVersion reads an agent's draft.
func GetAgentVersion(ctx context.Context, client *caitlyn.Client, agentID string) (*caitlyn.AgentVersion, error) {
	// #region get-agent-version
	draft, err := client.Agent(agentID).Draft().Get(ctx)
	if err != nil {
		return nil, err
	}
	fmt.Println(draft.Name, draft.ETag) // send the ETag back as WithIfMatch to change the draft
	// #endregion
	return draft, nil
}

// Chat starts a conversation with the agent's live version and streams the answer to a question (spec job 8).
func Chat(ctx context.Context, client *caitlyn.Client, agentID string) (*caitlyn.CreatedConversation, error) {
	// #region chat
	conversation, err := client.Agent(agentID).Live().Conversations.Create(ctx, nil)
	if err != nil {
		return nil, err
	}
	// Send sends the message before it returns; reading the stream is up to you
	stream, err := conversation.Send(ctx, "How much leave do part-time staff get?")
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	for text, err := range caitlyn.Text(stream) {
		if err != nil {
			return nil, err
		}
		fmt.Print(text)
	}
	// #endregion
	return conversation, nil
}

// SendAttachments asks a question about documents the message carries: a file on disk and an upload already sent.
func SendAttachments(ctx context.Context, client *caitlyn.Client, conversationID, path, uploadID string) (*caitlyn.Message, error) {
	// #region send-attachments
	// Each file is uploaded for this conversation first, then one message names them all, in order. If a file fails to
	// upload, no message is sent and Send returns that file's error. Sending the same files again uploads them again.
	stream, err := client.Conversation(conversationID).Send(ctx, "Does this leave form match our policy?",
		caitlyn.WithAttachments(caitlyn.Path(path), caitlyn.UploadID(uploadID)))
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	for text, err := range caitlyn.Text(stream) {
		if err != nil {
			return nil, err
		}
		fmt.Print(text)
	}
	// #endregion
	return stream.FinalMessage()
}

// CreateConversation starts a conversation with an agent's draft.
func CreateConversation(ctx context.Context, client *caitlyn.Client, agentID string) (*caitlyn.CreatedConversation, error) {
	// #region create-conversation
	// From the version that answers: Draft(), Live(), or a published one, such as Version("v3")
	conversation, err := client.Agent(agentID).Draft().Conversations.Create(ctx, &caitlyn.CreateConversationInput{
		Title: caitlyn.Ptr("Leave questions"),
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(conversation.ID())
	// #endregion
	return conversation, nil
}

// SendMessage asks a question and streams the answer.
func SendMessage(ctx context.Context, client *caitlyn.Client, conversationID string) (*caitlyn.Message, error) {
	// #region send-message
	stream, err := client.Conversation(conversationID).Send(ctx, "How much annual leave do part-time staff get?")
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	for event, err := range stream.Events() {
		if err != nil {
			return nil, err
		}
		if delta, ok := event.(*caitlyn.TextDelta); ok {
			fmt.Print(delta.Delta)
		}
	}
	answer, err := stream.FinalMessage() // the complete message, with its citations
	if err != nil {
		return nil, err
	}
	fmt.Println()
	// #endregion
	return answer, nil
}

// WatchConversation follows an answer after a page reload, with only the conversation's ID, until it is complete.
func WatchConversation(ctx context.Context, client *caitlyn.Client, conversationID string) (*caitlyn.Message, error) {
	// #region watch-conversation
	// The answer being written, if any, from its start, then every answer after it, until you close the stream. Each
	// answer ends with message.completed or message.failed; the stream carries on after either.
	stream, err := client.Conversation(conversationID).Watch(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	for event, err := range stream.Events() {
		if err != nil {
			return nil, err
		}
		switch e := event.(type) {
		case *caitlyn.TextDelta:
			fmt.Print(e.Delta)
		case *caitlyn.MessageCompleted:
			fmt.Println()
			return &e.Message, nil // the answer is complete: stop watching
		case *caitlyn.MessageFailed:
			return nil, fmt.Errorf("the answer failed: %s, %s [%s]", e.Code, e.Title, e.RequestID) // stop watching
		}
	}
	// #endregion
	return nil, errors.New("the stream ended before the answer was complete")
}

// WatchWorkspaceEvents waits for the conversation.created event of a conversation it starts.
func WatchWorkspaceEvents(ctx context.Context, client *caitlyn.Client, agentID string) (*caitlyn.ConversationCreatedEvent, error) {
	// #region watch-workspace-events
	// Open the stream first, then make the call whose event you are waiting for
	events, err := client.Events.Watch(ctx, &caitlyn.WatchWorkspaceEventsInput{
		Types: []string{"conversation.created"},
	})
	if err != nil {
		return nil, err
	}
	defer events.Close()

	conversation, err := client.Agent(agentID).Draft().Conversations.Create(ctx, nil)
	if err != nil {
		return nil, err
	}
	for event, err := range events.Events() {
		if err != nil {
			return nil, err
		}
		if created, ok := event.(*caitlyn.ConversationCreatedEvent); ok && created.Data.ID == conversation.ID() {
			fmt.Println(created.Data.ID, created.OccurredAt, created.EventID()) // the event ID is a cursor
			return created, nil
		}
	}
	// #endregion
	return nil, errors.New("the stream ended before conversation.created arrived")
}

// CarryOn picks up the workspace's events after a saved cursor, handles a cursor the stream cannot carry on
// from, and passes each event to handle until it returns an error. It returns the cursor to save.
func CarryOn(ctx context.Context, client *caitlyn.Client, savedCursor string, handle func(caitlyn.WorkspaceEvent) error) (string, error) {
	// #region stream-reset
	// Carry on after the last event you handled. A cursor the stream cannot carry on from (too old, say) is
	// answered with a StreamReset event and a new cursor, not an error.
	events, err := client.Events.Watch(ctx, &caitlyn.WatchWorkspaceEventsInput{
		Types: []string{"conversation.created"},
		After: caitlyn.Ptr(savedCursor),
	})
	if err != nil {
		return savedCursor, err
	}
	defer events.Close()
	for event, err := range events.Events() {
		if err != nil {
			return savedCursor, err
		}
		if reset, ok := event.(*caitlyn.StreamReset); ok {
			// Events since the old cursor may be missing: read the current state again, then carry on
			fmt.Println("Carrying on from", reset.Cursor)
		}
		if err := handle(event); err != nil {
			return savedCursor, err
		}
		savedCursor = event.EventID() // save it once the event is handled
	}
	// #endregion
	return savedCursor, nil
}
