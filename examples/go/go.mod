// The Go examples the developer docs show: hand-written (gettingstarted, signin, concepts, conversations, documents, agents) and
// generated from the model's @examples (reference/, by scripts/docs-snippets.mjs). scripts/test-go.sh builds and
// vets them. live runs the conversations, documents and agents examples against a real server (scripts/examples-live/go.sh).
module github.com/caitlyn-ai/caitlyn-go/examples

go 1.23.0

require (
	github.com/caitlyn-ai/caitlyn-go v0.0.1
	go.opentelemetry.io/otel v1.38.0
)

require (
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	go.opentelemetry.io/auto/sdk v1.1.0 // indirect
	go.opentelemetry.io/otel/metric v1.38.0 // indirect
	go.opentelemetry.io/otel/trace v1.38.0 // indirect
)

// The SDK in this repository, not a published version.
replace github.com/caitlyn-ai/caitlyn-go => ../../go
