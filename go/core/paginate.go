package core

import (
	"context"
	"iter"
)

// Pages yields pages until the cursor runs out. fetch gets the cursor to send (start for the first page)
// and returns the page and the next cursor.
func Pages[P any](ctx context.Context, start *string, fetch func(ctx context.Context, cursor *string) (P, *string, error)) iter.Seq2[P, error] {
	return func(yield func(P, error) bool) {
		cursor := start
		for {
			page, next, err := fetch(ctx, cursor)
			if err != nil {
				var zero P
				yield(zero, err)
				return
			}
			if !yield(page, nil) || next == nil || *next == "" {
				return
			}
			cursor = next
		}
	}
}

// Items flattens pages into their items.
func Items[P any, T any](pages iter.Seq2[P, error], items func(P) []T) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		for page, err := range pages {
			if err != nil {
				var zero T
				yield(zero, err)
				return
			}
			for _, it := range items(page) {
				if !yield(it, nil) {
					return
				}
			}
		}
	}
}
