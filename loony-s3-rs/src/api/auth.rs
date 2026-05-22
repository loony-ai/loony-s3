use axum::{
    async_trait,
    extract::FromRequestParts,
    http::{header, request::Parts, StatusCode},
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

use crate::api::state::AppState;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub:  String,
    pub name: String,
    pub exp:  usize,
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id:   String,
    pub name: String,
}

/// Requires a valid JWT or API-key header.
#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let secret = &state.config.auth.jwt_secret;

        let header_val = parts.headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Unauthorized("Missing Authorization header".into()))?;

        if let Some(token) = header_val.strip_prefix("Bearer ") {
            return decode_jwt(token, secret);
        }
        if let Some(encoded) = header_val.strip_prefix("ApiKey ") {
            return decode_api_key(encoded);
        }

        Err(AppError::Unauthorized("Unsupported auth scheme".into()))
    }
}

/// Like `AuthUser` but does not reject unauthenticated requests.
#[derive(Debug, Clone)]
pub struct OptionalAuth(pub Option<AuthUser>);

#[async_trait]
impl FromRequestParts<AppState> for OptionalAuth {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await.ok();
        Ok(OptionalAuth(user))
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn decode_jwt(token: &str, secret: &str) -> Result<AuthUser, AppError> {
    let mut val = Validation::new(Algorithm::HS256);
    val.validate_exp = true;

    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &val,
    ).map_err(|e| AppError::Unauthorized(format!("Invalid token: {e}")))?;

    Ok(AuthUser {
        id:   data.claims.sub,
        name: data.claims.name,
    })
}

fn decode_api_key(encoded: &str) -> Result<AuthUser, AppError> {
    let decoded = B64.decode(encoded)
        .map_err(|_| AppError::Unauthorized("Malformed API key".into()))?;
    let text = String::from_utf8(decoded)
        .map_err(|_| AppError::Unauthorized("Malformed API key".into()))?;

    // Expected format: "<user_id>:<name>"
    let mut parts = text.splitn(2, ':');
    let id   = parts.next().unwrap_or("").to_string();
    let name = parts.next().unwrap_or("").to_string();

    if id.is_empty() {
        return Err(AppError::Unauthorized("Invalid API key payload".into()));
    }

    Ok(AuthUser { id, name })
}

// ── issue JWT (used by /auth/token handler) ───────────────────────────────────

pub fn issue_jwt(user_id: &str, name: &str, secret: &str, expiry_secs: u64) -> Result<String, AppError> {
    use jsonwebtoken::{encode, EncodingKey, Header};

    let exp = (chrono::Utc::now().timestamp() as u64)
        .saturating_add(expiry_secs) as usize;

    let claims = Claims { sub: user_id.to_string(), name: name.to_string(), exp };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    ).map_err(|e| AppError::Internal(e.to_string()))
}

/// Returns a base64-encoded API key for the given user.
pub fn issue_api_key(user_id: &str, name: &str) -> String {
    B64.encode(format!("{user_id}:{name}"))
}

// Expose StatusCode for the rejection type alias used internally by axum
#[allow(dead_code)]
const _: StatusCode = StatusCode::UNAUTHORIZED;
