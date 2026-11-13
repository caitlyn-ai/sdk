# The code on the developer docs' Errors, Retries, Streaming, Pagination and Telemetry pages (docs/*.md), one
# region each. scripts/test-python.sh type-checks this file against the SDK (pyright --strict).
import os

from opentelemetry import trace

from caitlyn import (
    Caitlyn,
    CaitlynConnectionError,
    CaitlynError,
    CitationAddedEvent,
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
        caitlyn.versions.get(agent_id=agent_id, version="v99")
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
    with caitlyn.conversations.send(conversation_id, message="How much annual leave do part-time staff get?") as stream:
        for event in stream:
            if isinstance(event, TextDeltaEvent):
                print(event.delta, end="", flush=True)
            elif isinstance(event, CitationAddedEvent):
                print(f"\n[{event.citation.number}] {event.citation.document_name}")
        answer = stream.final_message()  # the complete message, with its citations
        print(answer.id, stream.request_id)
    # #endregion


def pagination() -> None:
    # #region pagination
    # Every document in the folder: the next page is fetched as the loop reaches it
    for document in caitlyn.documents.list(knowledge_base_id="KB4T7YQ2WL", folder="hr/", limit=100):
        print(document.name, document.status)

    # Or page by page
    for page in caitlyn.documents.list(knowledge_base_id="KB4T7YQ2WL", limit=100).pages():
        print(len(page.items), page.next_cursor)
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
