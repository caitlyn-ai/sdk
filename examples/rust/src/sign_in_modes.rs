//! A client in each sign-in mode. The developer docs' Authentication page (docs/authentication.md) shows each
//! region; scripts/test-rust.sh runs clippy over it.
use std::sync::Arc;

use caitlyn_sdk::auth::WorkloadIdentity;
use caitlyn_sdk::{Auth, Callback, Client, MemoryTokenStore};

/// One client per mode.
pub async fn clients(session_cookie: &str, code: String, returned_state: String) -> Result<(), Box<dyn std::error::Error>> {
    // #region token
    let script = Client::new("your-company.getcaitlyn.ai", Auth::token(std::env::var("CAITLYN_TOKEN")?))?;
    // #endregion

    // #region client-credentials
    let service = Client::new(
        "your-company.getcaitlyn.ai",
        Auth::client_credentials(std::env::var("CAITLYN_CLIENT_ID")?, std::env::var("CAITLYN_CLIENT_SECRET")?)
            .scopes(["api:read"]),
    )?;
    // #endregion

    // #region oauth
    let as_person = Client::new(
        "your-company.getcaitlyn.ai",
        Auth::oauth(std::env::var("CAITLYN_CLIENT_ID")?)
            .client_secret(std::env::var("CAITLYN_CLIENT_SECRET")?) // a confidential client on a server
            .redirect_uri("https://app.example.com/caitlyn/callback")
            .scopes(["api:write"])
            .token_store(Arc::new(MemoryTokenStore::new(None))), // your own encrypted store on a server
    )?;

    // Send the person to start.url, and keep start.state and start.code_verifier for the callback
    let start = as_person.auth().authorization_url(None, None, None)?;
    // #endregion

    // #region oauth-callback
    as_person
        .auth()
        .handle_callback(Callback {
            code,
            state: Some(returned_state),
            expected_state: Some(start.state),
            code_verifier: start.code_verifier,
            ..Default::default()
        })
        .await?;
    // #endregion

    // #region aws-iam
    let worker = Client::new("your-company.getcaitlyn.ai", Auth::aws_iam().region("ap-southeast-2"))?;
    // #endregion

    // #region workload-identity
    let ci_job = Client::new("your-company.getcaitlyn.ai", WorkloadIdentity::from_env("CAITLYN_ID_TOKEN"))?;
    // #endregion

    // #region session
    let local_app = Client::new("caitlyn.lndo.site", Auth::session(session_cookie).origin("https://caitlyn.lndo.site"))?;
    // #endregion

    drop((script, service, worker, ci_job, local_app));
    Ok(())
}
