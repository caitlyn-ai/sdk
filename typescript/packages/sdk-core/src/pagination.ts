/**
 * A list (PROTOCOL.md 10, `@paginated`): iterated, it yields every item on every page, following `nextCursor`;
 * `pages()` yields the pages themselves, and `page()` reads one. All three start from the input's `cursor`, or from
 * the first page when it has none, and request nothing until they are used.
 *
 * A page is the operation's output: its items, and `nextCursor` when another page follows. `nextPage()` reads the
 * page after it with the same input, and `hasNextPage` says whether there is one. Keep `nextCursor` for state that
 * outlives the page (a stored or deep-linked position): sent as `cursor`, it reads the same next page. Cursors only go
 * forward, so there is no previous page: a screen that goes back keeps its own history of cursors.
 */
export interface Paginated<P, I> extends AsyncIterable<I> {
  /** The pages, from the input's `cursor` to the last page. */
  pages(): AsyncIterable<Page<P>>;
  /** One page, from the input's `cursor`: exactly one request. */
  page(): Promise<Page<P>>;
}

/** A page of a list: the operation's output, with the way to the page after it. */
export type Page<P> = P & {
  /** Whether another page follows (the page has a `nextCursor`). */
  readonly hasNextPage: boolean;
  /** The page after this one, with the same input: exactly one request. `null` on the last page, with no request. */
  nextPage(): Promise<Page<P> | null>;
};

/**
 * Makes a list from the operation's paginator.
 *
 * @param open - Opens the paginator from a cursor (the input's own when undefined): every iteration, `page()` and
 *   `nextPage()` reads afresh.
 * @param items - A page's items.
 * @param next - A page's `nextCursor`.
 * @param cursor - Where this list starts, when it is a page's next page.
 */
export function paginated<P extends object, I>(
  open: (cursor: string | undefined) => AsyncIterable<P>,
  items: (page: P) => readonly I[],
  next: (page: P) => string | undefined,
  cursor?: string,
): Paginated<P, I> {
  const link = (page: P): Page<P> => {
    const after = next(page) || undefined;
    // Not enumerable: a page still serialises, compares and spreads as the operation's output.
    Object.defineProperties(page, {
      hasNextPage: { value: after !== undefined, configurable: true },
      nextPage: { value: async () => (after === undefined ? null : paginated(open, items, next, after).page()), configurable: true },
    });
    return page as Page<P>;
  };
  const pages = async function* (): AsyncGenerator<Page<P>> {
    for await (const page of open(cursor)) yield link(page);
  };
  return {
    pages,
    async page(): Promise<Page<P>> {
      // The first page only: leaving the loop ends the paginator before it asks for a second.
      for await (const page of pages()) return page;
      throw new Error('A list gave no page');
    },
    async *[Symbol.asyncIterator](): AsyncIterator<I> {
      for await (const page of open(cursor)) yield* items(page);
    },
  };
}
