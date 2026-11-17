// This file is hand-written, not generated: a conversation's Send, with the message as an argument and attachments
// (PROTOCOL.md 16, "Attachments"; spec job 8). The generated send it calls is SendMessage itself
// (codegen/smithy-build.json names it handWritten). scripts/generate.sh keeps every file in go/ that is not marked as
// generated.

package caitlyn

import "context"

// SendOption configures one Send: WithAttachments, WithMessageContext, WithSendOptions.
type SendOption func(*sendSettings)

type sendSettings struct {
	attachments []File
	context     []ContextItem
	call        []CallOption
}

// WithAttachments has the message carry these documents, in this order: each a file (a Path, an *UploadFile) uploaded
// for this conversation before the message is sent, or an UploadID already reserved for it and sent, used as it is.
// The server refuses more than the agent version's attachments.maxFiles; each upload is used up when the message is
// saved, so sending the same files again uploads them again.
func WithAttachments(files ...File) SendOption {
	return func(s *sendSettings) { s.attachments = append(s.attachments, files...) }
}

// WithMessageContext gives this message structured context, at most 20 items and 16 KB, not stored on the conversation.
func WithMessageContext(items ...ContextItem) SendOption {
	return func(s *sendSettings) { s.context = append(s.context, items...) }
}

// WithSendOptions passes call options to SendMessage itself.
func WithSendOptions(opts ...CallOption) SendOption {
	return func(s *sendSettings) { s.call = append(s.call, opts...) }
}

// Send sends a message to the conversation and returns the answer's stream; the message is sent before Send returns,
// whether or not the stream is read. With WithAttachments, each file is first reserved with
// purpose {conversationId} and uploaded, then one message names every upload in order; if any file fails to upload,
// no message is sent and Send returns that file's error.
//
// Close the stream when you are done with it (defer stream.Close()), or cancel ctx: a loop over its Events that
// breaks early leaves the connection open, so FinalMessage can still drain it. FinalMessage closes it too.
//
//	stream, err := conversation.Send(ctx, "Does this leave form match our policy?", caitlyn.WithAttachments(caitlyn.Path("./leave.pdf")))
//	if err != nil {
//		return err
//	}
//	defer stream.Close()
func (s *ConversationScope) Send(ctx context.Context, text string, opts ...SendOption) (*ConversationEventStream, error) {
	var st sendSettings
	for _, o := range opts {
		o(&st)
	}
	in := &SendMessageInput{Message: text, Context: st.context}
	for _, f := range st.attachments {
		id, err := s.c.uploadID(ctx, f, &UploadPurpose{ConversationID: Ptr(s.conversationID)})
		if err != nil {
			return nil, err
		}
		in.Attachments = append(in.Attachments, AttachmentReference{UploadID: id})
	}
	return s.send(ctx, in, st.call...)
}
