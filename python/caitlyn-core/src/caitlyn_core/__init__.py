"""caitlyn-core: the hand-written runtime under Caitlyn's generated Python SDK.

Generated packages import from here; applications normally import from ``caitlyn`` instead."""

from ._client import (
    workspace_endpoint,
    AsyncClientCore,
    AsyncEventStream,
    ClientConfig,
    EventDecoder,
    EventStream,
    Resume,
    SyncClientCore,
)
from ._errors import CaitlynConnectionError, CaitlynError, NotSupportedByServer, StreamLostError
from ._hooks import CallContext, Interceptor
from .auth import AsyncAuthSession, Auth, CaitlynAuthError, SyncAuthSession
from ._models import CaitlynEvent, CaitlynModel, CaitlynPage, CaitlynResult, FieldError, OpenEnum, ResponseMetadata
from ._pagination import AsyncPaginator, Paginator
from ._retry import RetryPolicy
from ._spec import Member, OperationSpec
from ._scopes import (
    AsyncFollow,
    AsyncStarted,
    Follow,
    ReadersShorthand,
    ReadersSpecific,
    Started,
    WaitTimeoutError,
    Watched,
    error_for_code,
    event_processing,
    readers_input,
    trim_slashes,
)
from ._files import CONTENT_TYPES, MAX_FILE_SIZE, ByteStream, FileInput, PreparedFile, UploadFile, content_type_for, url_safe_sha256
from ._sync import AsyncHelperCore, BatchFiles, BatchUpload, SyncApi, batch_upload_async, batch_upload_estimate_async, SyncCancelledError, SyncInterrupted, SyncFile, SyncHelperCore, SyncPlan, IngestionProgress, SyncReport, run_sync, sync_async, sync_estimate_async, walk
from ._uploads import UploadId, attachment_refs, attachment_refs_async, file_at, with_upload_id

__version__ = "0.12.0-beta.1"

__all__ = [
    "AsyncHelperCore",
    "BatchFiles",
    "BatchUpload",
    "batch_upload_async",
    "batch_upload_estimate_async",
    "SyncApi",
    "SyncCancelledError",
    "SyncInterrupted",
    "SyncFile",
    "SyncHelperCore",
    "SyncPlan",
    "IngestionProgress",
    "SyncReport",
    "run_sync",
    "sync_async",
    "sync_estimate_async",
    "walk",
    "ByteStream",
    "CONTENT_TYPES",
    "FileInput",
    "MAX_FILE_SIZE",
    "PreparedFile",
    "content_type_for",
    "file_at",
    "UploadId",
    "attachment_refs",
    "attachment_refs_async",
    "url_safe_sha256",
    "with_upload_id",
    "AsyncAuthSession",
    "AsyncClientCore",
    "AsyncEventStream",
    "AsyncFollow",
    "AsyncPaginator",
    "AsyncStarted",
    "Auth",
    "CaitlynAuthError",
    "CaitlynConnectionError",
    "CaitlynError",
    "CaitlynEvent",
    "CaitlynModel",
    "CaitlynPage",
    "CaitlynResult",
    "CallContext",
    "ClientConfig",
    "EventDecoder",
    "EventStream",
    "FieldError",
    "Follow",
    "Interceptor",
    "Member",
    "NotSupportedByServer",
    "OpenEnum",
    "OperationSpec",
    "Paginator",
    "ReadersShorthand",
    "ReadersSpecific",
    "ResponseMetadata",
    "Resume",
    "RetryPolicy",
    "Started",
    "StreamLostError",
    "SyncAuthSession",
    "SyncClientCore",
    "UploadFile",
    "WaitTimeoutError",
    "Watched",
    "error_for_code",
    "event_processing",
    "readers_input",
    "trim_slashes",
    "workspace_endpoint",
]
