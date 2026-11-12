package core

import (
	"context"
	"errors"
	"net/url"
	"reflect"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// The spans every SDK emits (PROTOCOL.md 13): caitlyn.call per call, a caitlyn.attempt child per HTTP attempt,
// and caitlyn.upload for an upload's bytes.

// httpAttributes are http.request.method, server.address and url.full. The URL loses its query, fragment and
// user information, which can carry secrets (a presigned URL's signature).
func httpAttributes(method, rawURL string) []attribute.KeyValue {
	attrs := []attribute.KeyValue{attribute.String("http.request.method", method)}
	if u, err := url.Parse(rawURL); err == nil {
		u.RawQuery, u.ForceQuery, u.Fragment, u.RawFragment, u.User = "", false, "", "", nil
		attrs = append(attrs, attribute.String("server.address", u.Hostname()), attribute.String("url.full", u.String()))
	}
	return attrs
}

// recordFailure sets the span's status, error.type (the error's class name), caitlyn.error.code and an
// exception event.
func recordFailure(span trace.Span, err error) {
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	span.SetAttributes(attribute.String("error.type", ErrorType(err)))
	var ae interface{ apiError() *APIError }
	if errors.As(err, &ae) && ae.apiError().Code != "" {
		span.SetAttributes(attribute.String("caitlyn.error.code", ae.apiError().Code))
	}
	var au *AuthError
	if errors.As(err, &au) && au.Code != "" {
		span.SetAttributes(attribute.String("caitlyn.error.code", au.Code))
	}
}

// ErrorType is an error's class name as every SDK reports it in error.type: the model's error shape name for a
// typed error (NotFoundError), CaitlynError for the generic one, CaitlynConnectionError, CaitlynAuthError,
// NotSupportedByServer, and Cancelled for a cancelled call.
func ErrorType(err error) string {
	var ce *ConnectionError
	var au *AuthError
	var ns *NotSupportedByServerError
	switch {
	case errors.As(err, &ce):
		return "CaitlynConnectionError"
	case errors.As(err, &au):
		return "CaitlynAuthError"
	case errors.As(err, &ns):
		return "NotSupportedByServer"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "Cancelled"
	}
	t := reflect.TypeOf(err)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Name() == "APIError" || t.Name() == "" {
		return "CaitlynError"
	}
	return t.Name()
}
