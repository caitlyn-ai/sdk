# A client in each sign-in mode. The developer docs' Authentication page (docs/authentication.md) shows each
# region; scripts/test-python.sh type-checks this file against the SDK (pyright --strict).
import os

from caitlyn import Caitlyn
from caitlyn.auth import AwsIam, ClientCredentials, OAuth, Session, Token, TokenStore, WorkloadIdentity


def encrypted_token_store_for(user_id: str) -> TokenStore: ...


user_id = "u-1"
session_cookie = "caitlyn_session=…"

# #region token
script = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=Token(os.environ["CAITLYN_TOKEN"]),  # a personal access token, cait-pat-…
)
# #endregion

# #region client-credentials
service = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=ClientCredentials(
        client_id=os.environ["CAITLYN_CLIENT_ID"],
        client_secret=os.environ["CAITLYN_CLIENT_SECRET"],
        scopes=["api:read"],
    ),
)
# #endregion

# #region oauth
as_person = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=OAuth(
        client_id=os.environ["CAITLYN_CLIENT_ID"],
        client_secret=os.environ.get("CAITLYN_CLIENT_SECRET"),  # a confidential client on a server
        redirect_uri="https://app.example.com/caitlyn/callback",
        scopes=["api:write"],
        token_store=encrypted_token_store_for(user_id),  # load, save, clear; default: in memory
    ),
)

# Send the person to start.url, and keep start.state and start.code_verifier for the callback
start = as_person.auth.authorization_url()
# #endregion


def callback(code: str, returned_state: str) -> None:
    # #region oauth-callback
    as_person.auth.handle_callback(
        code=code,
        state=returned_state,
        expected_state=start.state,
        code_verifier=start.code_verifier,
    )
    # #endregion


# #region aws-iam
worker = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=AwsIam(region="ap-southeast-2"),  # the workload's own AWS credentials
)
# #endregion

# #region workload-identity
ci_job = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=WorkloadIdentity(token=lambda: os.environ["CAITLYN_ID_TOKEN"]),  # GitLab CI id_tokens
)
# #endregion

# #region session
local_app = Caitlyn(
    workspace="caitlyn.lndo.site",
    auth=Session(cookie=session_cookie, origin="https://caitlyn.lndo.site"),
)
# #endregion
