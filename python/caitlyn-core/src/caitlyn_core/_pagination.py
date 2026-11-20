"""Paginators (PROTOCOL.md 10): iterate every item across pages, the pages themselves, or one page."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Iterator

from ._models import CaitlynPage


class Paginator[P, I]:
    """``for item in paginator`` yields every item on every page; ``paginator.pages()`` the pages;
    ``paginator.page()`` one page. Each starts from the call's ``cursor`` (the first page without one), and nothing
    is requested until it is used."""

    def __init__(
        self, fetch: Callable[[str | None], P], items: Callable[[P], Iterable[I]], next_token: Callable[[P], str | None], start: str | None = None
    ) -> None:
        self._fetch, self._items, self._next, self._start = fetch, items, next_token, start

    def _read(self, token: str | None) -> P:
        page = self._fetch(token)
        if isinstance(page, CaitlynPage):
            following = self._next(page)
            page._bind_next(lambda: self._read(following), False)  # pyright: ignore[reportPrivateUsage]
        return page

    def pages(self) -> Iterator[P]:
        token = self._start
        while True:
            page = self._read(token)
            yield page
            token = self._next(page)
            if not token:
                return

    def page(self) -> P:
        """One page, from the call's ``cursor``: exactly one request. Its ``next_page()`` reads the page after it, and
        its ``next_cursor``, passed as ``cursor``, reads the same page later."""
        return self._read(self._start)

    def __iter__(self) -> Iterator[I]:
        for page in self.pages():
            yield from self._items(page)


class AsyncPaginator[P, I]:
    """``async for item in paginator`` yields every item on every page; ``paginator.pages()`` the pages;
    ``await paginator.page()`` one page. Each starts from the call's ``cursor``."""

    def __init__(
        self,
        fetch: Callable[[str | None], Awaitable[P]],
        items: Callable[[P], Iterable[I]],
        next_token: Callable[[P], str | None],
        start: str | None = None,
    ) -> None:
        self._fetch, self._items, self._next, self._start = fetch, items, next_token, start

    async def _read(self, token: str | None) -> P:
        page = await self._fetch(token)
        if isinstance(page, CaitlynPage):
            following = self._next(page)
            page._bind_next(lambda: self._read(following), True)  # pyright: ignore[reportPrivateUsage]
        return page

    async def pages(self) -> AsyncIterator[P]:
        token = self._start
        while True:
            page = await self._read(token)
            yield page
            token = self._next(page)
            if not token:
                return

    async def page(self) -> P:
        """One page, from the call's ``cursor``: exactly one request. Its ``await next_page_async()`` reads the page
        after it."""
        return await self._read(self._start)

    async def __aiter__(self) -> AsyncIterator[I]:
        async for page in self.pages():
            for item in self._items(page):
                yield item
