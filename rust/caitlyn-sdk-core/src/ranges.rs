//! The `@range` check (PROTOCOL.md 3): before sending, a value outside its member's declared range is refused, as
//! the server would refuse it, so a call that cannot succeed costs no request. The rules come from the model
//! (codegen/model-support `Ranges`). The check reads the request as it will be sent, so its field errors name the
//! value as the server's would: `parameter` for a query parameter, `pointer` for a body value.

use serde_json::Value;

use crate::error::{ApiError, Error, FieldError};
use crate::request::Request;

/// One `@range` rule a request carries: `place` is `"query"` (`path` a parameter name) or `"body"` (`path` a JSON
/// Pointer pattern in which `*` stands for any list item or map value); `None` is no bound.
#[derive(Debug, Clone, Copy)]
pub struct Range {
    pub place: &'static str,
    pub path: &'static str,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

fn outside(r: &Range, v: f64) -> bool {
    r.min.is_some_and(|m| v < m) || r.max.is_some_and(|m| v > m)
}

fn bounds(r: &Range) -> String {
    match (r.min, r.max) {
        (Some(lo), Some(hi)) => format!("between {lo} and {hi}"),
        (Some(lo), None) => format!("at least {lo}"),
        (None, Some(hi)) => format!("at most {hi}"),
        (None, None) => String::new(),
    }
}

fn escape(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// Refuses a request with a value outside its rule's range: VALIDATION_FAILED with a field error for each value, as
/// the server's 400 would be (the generated crate's validation variant), but status 0, and nothing sent.
pub(crate) fn check(rules: &[Range], req: &Request) -> Result<(), Error> {
    if rules.is_empty() {
        return Ok(());
    }
    let body: Option<Value> = req.body.as_deref().and_then(|b| serde_json::from_slice(b).ok());
    let mut problems = Vec::new();
    for r in rules {
        if r.place == "query" {
            for (_, raw) in req.query.iter().filter(|(k, _)| k == r.path) {
                if let Ok(n) = raw.parse::<f64>() {
                    if outside(r, n) {
                        problems.push(FieldError {
                            pointer: None,
                            parameter: Some(r.path.to_owned()),
                            code: "VALIDATION_FAILED".to_owned(),
                            detail: Some(format!("`{}` must be {}; it is {raw}.", r.path, bounds(r))),
                        });
                    }
                }
            }
            continue;
        }
        let Some(root) = &body else { continue };
        let mut at: Vec<(String, &Value)> = vec![(String::new(), root)];
        for seg in r.path.split('/').skip(1) {
            let mut next = Vec::new();
            for (p, v) in at {
                match v {
                    Value::Object(o) if seg == "*" => next.extend(o.iter().map(|(k, c)| (format!("{p}/{}", escape(k)), c))),
                    Value::Object(o) => next.extend(o.get(seg).map(|c| (format!("{p}/{}", escape(seg)), c))),
                    Value::Array(a) if seg == "*" => next.extend(a.iter().enumerate().map(|(i, c)| (format!("{p}/{i}"), c))),
                    _ => {}
                }
            }
            at = next;
        }
        for (pointer, v) in at {
            if let Some(n) = v.as_f64() {
                if outside(r, n) {
                    problems.push(FieldError {
                        detail: Some(format!("`{pointer}` must be {}; it is {v}.", bounds(r))),
                        pointer: Some(pointer),
                        parameter: None,
                        code: "VALIDATION_FAILED".to_owned(),
                    });
                }
            }
        }
    }
    if problems.is_empty() {
        return Ok(());
    }
    let detail = if problems.len() == 1 {
        problems[0].detail.clone().unwrap_or_default()
    } else {
        let all: Vec<String> = problems.iter().filter_map(|p| p.detail.clone()).collect();
        format!("{} values are out of range. {}", problems.len(), all.join(" "))
    };
    Err(Error::Invalid(Box::new(ApiError {
        code: "VALIDATION_FAILED".to_owned(),
        title: Some("The request is not valid".to_owned()),
        detail: Some(detail),
        errors: problems,
        ..ApiError::default()
    })))
}
