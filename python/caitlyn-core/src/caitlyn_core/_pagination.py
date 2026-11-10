"""Paginators: iterate every item across pages, or the pages themselves."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Iterator


class Paginator[P, I]:
    """``for item in paginator`` yields every item on every page; ``paginator.pages()`` the pages.
    Nothing is requested until iteration starts."""

    def __init__(
        self, fetch: Callable[[str | None], P], items: Callable[[P], Iterable[I]], next_token: Callable[[P], str | None], start: str | None = None
    ) -> None:
        self._fetch, self._items, self._next, self._start = fetch, items, next_token, start

    def pages(self) -> Iterator[P]:
        token = self._start
        while True:
            page = self._fetch(token)
            yield page
            token = self._next(page)
            if not token:
                return

    def __iter__(self) -> Iterator[I]:
        for page in self.pages():
            yield from self._items(page)


class AsyncPaginator[P, I]:
    """``async for item in paginator`` yields every item on every page; ``paginator.pages()`` the pages."""

    def __init__(
        self,
        fetch: Callable[[str | None], Awaitable[P]],
        items: Callable[[P], Iterable[I]],
        next_token: Callable[[P], str | None],
        start: str | None = None,
    ) -> None:
        self._fetch, self._items, self._next, self._start = fetch, items, next_token, start

    async def pages(self) -> AsyncIterator[P]:
        token = self._start
        while True:
            page = await self._fetch(token)
            yield page
            token = self._next(page)
            if not token:
                return

    async def __aiter__(self) -> AsyncIterator[I]:
        async for page in self.pages():
            for item in self._items(page):
                yield item
