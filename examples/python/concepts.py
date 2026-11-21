# The code on the developer docs' Errors, Retries, Streaming, Pagination and Telemetry pages (docs/*.md), one
# region each. scripts/test-python.sh type-checks this file against the SDK (pyright --strict).
import os

from opentelemetry import trace

from caitlyn import (
    Caitlyn,
    CaitlynConnectionError,
    CaitlynError,
    CitationAddedEvent,
    Document,
    NotFoundError,
    TextDeltaEvent,
    ValidationError,
)
from caitlyn.auth import Token

caitlyn = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))
agent_id = "GHT7YRWXPL"
conversation_id = "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47"


def errors() -> None:
    # #region errors
    try:
        caitlyn.agents(agent_id).versions("v99").get()
    except NotFoundError:
        print("No such version")
    except ValidationError as err:
        for e in err.errors:  # one per member or parameter at fault
            print(e.pointer, e.code, e.detail)
    except CaitlynConnectionError as err:
        print("No response from Caitlyn:", err.__cause__)  # after the SDK's retries
    except CaitlynError as err:
        # Any other status. code is the stable product code; quote request_id to support.
        print(err.status, err.code, err.detail, err.request_id)
        if err.code.startswith("HTTP_"):
            print(err.raw_body)  # not a Caitlyn error body: a proxy's page, say
    # #endregion


def retries() -> Caitlyn:
    # #region retries
    patient = Caitlyn(
        workspace="your-company.getcaitlyn.ai",
        auth=Token(os.environ["CAITLYN_TOKEN"]),
        max_attempts=5,  # the first attempt included; default 3
        max_retry_delay=120,  # seconds: the longest Retry-After to wait for; default 60
    )
    # #endregion
    return patient


def retry_budget() -> Caitlyn:
    # #region retry-budget
    batch = Caitlyn(
        workspace="your-company.getcaitlyn.ai",
        auth=Token(os.environ["CAITLYN_TOKEN"]),
        retry_budget=2000,  # retry tokens shared by every call on this client; default 500, and 0 turns retries off
    )
    # #endregion
    return batch


def streaming() -> None:
    # #region streaming
    with caitlyn.conversations(conversation_id).send("How much annual leave do part-time staff get?") as stream:
        for event in stream:
            if isinstance(event, TextDeltaEvent):
                print(event.delta, end="", flush=True)
            elif isinstance(event, CitationAddedEvent):
                print(f"\n[{event.citation.number}] {event.citation.document_name}")
        answer = stream.final_message()  # the complete message, with its citations
        print(answer.id, stream.request_id)
    # #endregion


def pagination_items() -> None:
    # #region pagination-items
    # Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
    documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
    for document in documents.list(folder="/policies/", limit=100):
        print(document.name, document.status)
        if document.name == "leave-policy.pdf":
            break  # stops here: no further page is requested
    # #endregion


def pagination_pages() -> None:
    # #region pagination-pages
    # Every page in turn, each with its items and next_cursor: for work done a batch at a time
    documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
    for page in documents.list(folder="/policies/", limit=100).pages():
        print(f"{len(page.items)} documents; more to come: {page.has_next_page}")
    # #endregion


def pagination_page() -> None:
    # #region pagination-page
    # One page, in exactly one request: the first 25 documents
    documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
    page = documents.list(folder="/policies/", limit=25).page()
    for document in page.items:
        print(document.name)
    print(page.next_cursor)  # None on the last page
    # #endregion


def pagination_next_page() -> None:
    def render(items: list[Document]) -> None:
        print([d.name for d in items])

    next_button = {"hidden": True}
    # #region pagination-has-next-page
    # Show the first page, and a "Next" button only when another page follows: knowing that takes no request
    documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
    page = documents.list(folder="/policies/", limit=25).page()
    render(page.items)
    next_button["hidden"] = not page.has_next_page
    # #endregion

    # #region pagination-next-page
    # The "Next" button's click handler: one request, for the page after the one shown
    def on_next_click() -> None:
        nonlocal page
        following = page.next_page()  # None after the last page; the asynchronous client's is await page.next_page_async()
        if following is None:
            return
        page = following
        render(page.items)
        next_button["hidden"] = not page.has_next_page
    # #endregion

    on_next_click()


def pagination_cursor(cursor: str | None) -> None:
    # #region pagination-cursor
    # Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
    documents = caitlyn.knowledge_bases("KB4T7YQ2WL").documents
    page = documents.list(folder="/policies/", limit=25, cursor=cursor).page()
    print(len(page.items), page.next_cursor)  # save page.next_cursor to carry on from here next time
    # #endregion


def telemetry() -> Caitlyn:
    # #region telemetry
    traced = Caitlyn(
        workspace="your-company.getcaitlyn.ai",
        auth=Token(os.environ["CAITLYN_TOKEN"]),
        tracer_provider=trace.get_tracer_provider(),  # default: the global provider
    )
    # #endregion
    return traced
