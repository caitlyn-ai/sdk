//! `raw` (PROTOCOL.md 4.1): every deserialised structure keeps the JSON object it was read from, unknown fields
//! included.

use serde_json::{Map, Value};

/// The JSON object a structure was read from. It is metadata: two values compare equal whatever their `Raw`.
#[derive(Clone, Debug, Default)]
pub struct Raw(Option<Map<String, Value>>);

impl Raw {
    pub fn new(v: Value) -> Self {
        match v {
            Value::Object(m) => Raw(Some(m)),
            _ => Raw(None),
        }
    }

    /// The object, or `None` when the value was not read from JSON.
    pub fn get(&self) -> Option<&Map<String, Value>> {
        self.0.as_ref()
    }
}

impl PartialEq for Raw {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

/// Deserialises `v` with the generated type's field-only implementation, then keeps `v` as its raw object.
pub fn with_raw<T, E: serde::de::Error>(
    v: Value,
    plain: impl FnOnce(&Value) -> Result<T, serde_json::Error>,
    set: impl FnOnce(&mut T, Raw),
) -> Result<T, E> {
    let mut out = plain(&v).map_err(E::custom)?;
    set(&mut out, Raw::new(v));
    Ok(out)
}
