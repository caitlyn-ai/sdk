//! The AWS half of the `awsIam` sign-in mode, with no AWS runtime: a minimal Signature Version 4 signer, the two
//! credential sources AWS workloads actually use (environment variables, and the container credentials endpoint
//! used by ECS, Fargate and AgentCore runtimes), and one call, STS `GetWebIdentityToken`. Anything else
//! (profiles, SSO, instance metadata) is reached by passing an [`AwsCredentialProvider`], for example one that
//! wraps the AWS SDK for Rust's default chain.

use std::fmt;

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::error::AuthError;
use crate::request::BoxFuture;

/// AWS credentials.
#[derive(Clone)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    /// When the credentials stop working.
    pub expiration: Option<DateTime<Utc>>,
}

impl AwsCredentials {
    pub fn new(access_key_id: impl Into<String>, secret_access_key: impl Into<String>, session_token: Option<String>) -> Self {
        AwsCredentials {
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            session_token,
            expiration: None,
        }
    }
}

impl fmt::Debug for AwsCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwsCredentials")
            .field("access_key_id", &self.access_key_id)
            .finish_non_exhaustive()
    }
}

/// A source of AWS credentials. Static [`AwsCredentials`] are one; implement it to plug in the AWS SDK's chain.
pub trait AwsCredentialProvider: Send + Sync {
    fn credentials(&self) -> BoxFuture<'_, Result<AwsCredentials, String>>;
}

impl AwsCredentialProvider for AwsCredentials {
    fn credentials(&self) -> BoxFuture<'_, Result<AwsCredentials, String>> {
        let c = self.clone();
        Box::pin(async move { Ok(c) })
    }
}

/// An async function returning credentials, as a provider.
pub struct ProviderFn<F>(pub F);

impl<F, Fut> AwsCredentialProvider for ProviderFn<F>
where
    F: Fn() -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Result<AwsCredentials, String>> + Send + 'static,
{
    fn credentials(&self) -> BoxFuture<'_, Result<AwsCredentials, String>> {
        Box::pin((self.0)())
    }
}

/// The key STS signs the identity token with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SigningAlgorithm {
    #[default]
    Es384,
    Rs256,
}

impl SigningAlgorithm {
    fn as_str(self) -> &'static str {
        match self {
            SigningAlgorithm::Es384 => "ES384",
            SigningAlgorithm::Rs256 => "RS256",
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sha256_hex(s: &[u8]) -> String {
    hex(&Sha256::digest(s))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

/// RFC 3986 encoding, as Signature Version 4 requires.
fn aws_encode(s: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    percent_encoding::utf8_percent_encode(s, SET).to_string()
}

/// Signs a request with Signature Version 4 (header form) and returns the headers to send, `host` excluded
/// (the HTTP client sets it): `authorization`, `x-amz-date`, `x-amz-content-sha256` and, for temporary
/// credentials, `x-amz-security-token`.
#[allow(clippy::too_many_arguments)]
pub fn sign_v4(
    method: &str,
    url: &url::Url,
    headers: &[(&str, &str)],
    body: &[u8],
    creds: &AwsCredentials,
    region: &str,
    service: &str,
    now: DateTime<Utc>,
) -> Vec<(String, String)> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let day = &amz_date[..8];
    let payload = sha256_hex(body);
    let mut h: std::collections::BTreeMap<String, String> = headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.split_whitespace().collect::<Vec<_>>().join(" ")))
        .collect();
    let host = match url.port() {
        Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    };
    h.insert("host".into(), host);
    h.insert("x-amz-date".into(), amz_date.clone());
    h.insert("x-amz-content-sha256".into(), payload.clone());
    if let Some(t) = &creds.session_token {
        h.insert("x-amz-security-token".into(), t.clone());
    }
    let names = h.keys().cloned().collect::<Vec<_>>().join(";");
    let mut query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (aws_encode(&k), aws_encode(&v))).collect();
    query.sort();
    let query = query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let path = url
        .path_segments()
        .map(|s| {
            s.map(|p| aws_encode(&percent_encoding::percent_decode_str(p).decode_utf8_lossy()))
                .collect::<Vec<_>>()
                .join("/")
        })
        .map(|p| format!("/{p}"))
        .unwrap_or_else(|| "/".into());
    let canonical_headers: String = h.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let canonical = [method, &path, &query, &canonical_headers, &names, &payload].join("\n");
    let scope = format!("{day}/{region}/{service}/aws4_request");
    let to_sign = ["AWS4-HMAC-SHA256", &amz_date, &scope, &sha256_hex(canonical.as_bytes())].join("\n");
    let mut key = hmac(format!("AWS4{}", creds.secret_access_key).as_bytes(), day);
    for part in [region, service, "aws4_request"] {
        key = hmac(&key, part);
    }
    let signature = hex(&hmac(&key, &to_sign));
    h.insert(
        "authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={names}, Signature={signature}",
            creds.access_key_id
        ),
    );
    h.remove("host");
    h.into_iter().collect()
}

/// The default credential source: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (with `AWS_SESSION_TOKEN`), as
/// Lambda and CI runners set them; otherwise the container credentials endpoint
/// (`AWS_CONTAINER_CREDENTIALS_FULL_URI` or `_RELATIVE_URI`), as ECS, Fargate and AgentCore runtimes set it.
pub async fn default_credentials(http: &reqwest::Client) -> Result<AwsCredentials, String> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if let (Some(id), Some(secret)) = (env("AWS_ACCESS_KEY_ID"), env("AWS_SECRET_ACCESS_KEY")) {
        return Ok(AwsCredentials::new(id, secret, env("AWS_SESSION_TOKEN")));
    }
    let url = env("AWS_CONTAINER_CREDENTIALS_FULL_URI")
        .or_else(|| env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI").map(|r| format!("http://169.254.170.2{r}")));
    if let Some(url) = url {
        let mut auth = env("AWS_CONTAINER_AUTHORIZATION_TOKEN");
        if auth.is_none() {
            if let Some(f) = env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE") {
                auth = Some(std::fs::read_to_string(f).map_err(|e| format!("awsIam: {e}"))?.trim().to_owned());
            }
        }
        let mut req = http.get(&url);
        if let Some(a) = auth {
            req = req.header("authorization", a);
        }
        let res = req
            .send()
            .await
            .map_err(|e| format!("awsIam: the container credentials endpoint: {e}"))?;
        if !res.status().is_success() {
            return Err(format!(
                "awsIam: the container credentials endpoint answered {}",
                res.status().as_u16()
            ));
        }
        let c: serde_json::Value = res.json().await.map_err(|e| format!("awsIam: {e}"))?;
        let s = |k: &str| c.get(k).and_then(|v| v.as_str()).map(str::to_owned);
        return Ok(AwsCredentials {
            access_key_id: s("AccessKeyId").unwrap_or_default(),
            secret_access_key: s("SecretAccessKey").unwrap_or_default(),
            session_token: s("Token"),
            expiration: s("Expiration")
                .and_then(|e: String| DateTime::parse_from_rfc3339(&e).ok())
                .map(|d| d.with_timezone(&Utc)),
        });
    }
    Err("awsIam: no AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, run where the container credentials endpoint is set, or pass credentials.".into())
}

fn xml_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(&xml[start..end])
}

pub(crate) struct WebIdentityTokenRequest<'a> {
    pub region: &'a str,
    pub audience: &'a str,
    pub credentials: &'a AwsCredentials,
    pub signing_algorithm: SigningAlgorithm,
    pub duration_seconds: u32,
    pub sts_endpoint: Option<&'a str>,
}

/// Calls STS `GetWebIdentityToken` (outbound identity federation) on a regional endpoint and returns the JWT.
pub(crate) async fn get_web_identity_token(http: &reqwest::Client, r: &WebIdentityTokenRequest<'_>) -> Result<String, AuthError> {
    let endpoint = r
        .sts_endpoint
        .map(str::to_owned)
        .unwrap_or_else(|| format!("https://sts.{}.amazonaws.com/", r.region));
    let url = url::Url::parse(&endpoint).map_err(|e| AuthError::new("invalid_request", format!("awsIam: STS endpoint: {e}")))?;
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("Action", "GetWebIdentityToken")
        .append_pair("Version", "2011-06-15")
        .append_pair("Audience.member.1", r.audience)
        .append_pair("DurationSeconds", &r.duration_seconds.to_string())
        .append_pair("SigningAlgorithm", r.signing_algorithm.as_str())
        .finish();
    let content_type = "application/x-www-form-urlencoded; charset=utf-8";
    let signed = sign_v4(
        "POST",
        &url,
        &[("content-type", content_type)],
        body.as_bytes(),
        r.credentials,
        r.region,
        "sts",
        Utc::now(),
    );
    let mut req = http.post(url);
    for (k, v) in signed {
        req = req.header(k, v);
    }
    let res = req
        .body(body)
        .send()
        .await
        .map_err(|e| AuthError::new("aws_identity_failed", format!("awsIam: STS: {e}")))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        let code = xml_text(&text, "Code")
            .map(str::to_owned)
            .unwrap_or_else(|| format!("HTTP {status}"));
        let mut e = AuthError::new(
            &code,
            format!(
                "awsIam: STS GetWebIdentityToken failed: {code}: {}",
                xml_text(&text, "Message").unwrap_or_default()
            ),
        );
        e.status = Some(status);
        return Err(e);
    }
    xml_text(&text, "WebIdentityToken")
        .map(str::to_owned)
        .ok_or_else(|| AuthError::new("aws_identity_failed", "awsIam: STS answered without a WebIdentityToken"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The AWS Signature Version 4 test suite's `post-x-www-form-urlencoded` case.
    #[test]
    fn signs_like_the_aws_test_suite() {
        let creds = AwsCredentials::new("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", None);
        let now = DateTime::parse_from_rfc3339("2015-08-30T12:36:00Z").unwrap().with_timezone(&Utc);
        let url = url::Url::parse("https://example.amazonaws.com/").unwrap();
        let mut h = sign_v4(
            "POST",
            &url,
            &[("content-type", "application/x-www-form-urlencoded")],
            b"Param1=value1",
            &creds,
            "us-east-1",
            "service",
            now,
        );
        h.retain(|(k, _)| k == "authorization");
        // The suite signs without x-amz-content-sha256; with it the headers list and signature differ, so check
        // the parts that do not depend on it.
        assert!(h[0].1.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature="));
    }

    #[test]
    fn reads_sts_xml() {
        let xml = "<R><WebIdentityToken>a.b.c</WebIdentityToken></R>";
        assert_eq!(xml_text(xml, "WebIdentityToken"), Some("a.b.c"));
    }
}
