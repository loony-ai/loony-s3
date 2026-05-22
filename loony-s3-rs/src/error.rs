use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;
use thiserror::Error;

pub type Result<T, E = AppError> = std::result::Result<T, E>;

#[derive(Error, Debug)]
pub enum AppError {
    // 400
    #[error("{0}")]
    BadRequest(String),
    // 401
    #[error("{0}")]
    Unauthorized(String),
    // 403
    #[error("{0}")]
    Forbidden(String),
    // 404
    #[error("{0}")]
    NotFound(String),
    // 409
    #[error("{0}")]
    Conflict(String),
    // 410
    #[error("{0}")]
    Gone(String),
    // 413
    #[error("Payload too large")]
    PayloadTooLarge,
    // 429
    #[error("Rate limit exceeded")]
    TooManyRequests,
    // 500
    #[error("{0}")]
    Internal(String),
    // pass-through from sqlx
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    // pass-through from IO
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::BadRequest(_)    => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            AppError::Unauthorized(_)  => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
            AppError::Forbidden(_)     => (StatusCode::FORBIDDEN, "ACCESS_DENIED"),
            AppError::NotFound(_)      => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            AppError::Conflict(_)      => (StatusCode::CONFLICT, "CONFLICT"),
            AppError::Gone(_)          => (StatusCode::GONE, "OBJECT_EXPIRED"),
            AppError::PayloadTooLarge  => (StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE"),
            AppError::TooManyRequests  => (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED"),
            AppError::Internal(_)
            | AppError::Database(_)
            | AppError::Io(_)          => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR"),
        };

        tracing::debug!(code, message = %self, "request error");

        (status, Json(json!({
            "error": {
                "code":       code,
                "message":    self.to_string(),
                "statusCode": status.as_u16(),
            }
        }))).into_response()
    }
}
