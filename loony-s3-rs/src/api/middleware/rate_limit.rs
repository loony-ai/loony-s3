use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use governor::{
    clock::DefaultClock,
    state::{InMemoryState, NotKeyed},
    Quota, RateLimiter,
};
use std::num::NonZeroU32;
use std::sync::Arc;

pub type Limiter = Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>;

pub fn new_limiter(max_per_window: u32) -> Limiter {
    let max = NonZeroU32::new(max_per_window.max(1)).unwrap();
    Arc::new(RateLimiter::direct(Quota::per_minute(max)))
}

pub async fn rate_limit_middleware(
    limiter: Limiter,
    req: Request,
    next: Next,
) -> Response {
    if limiter.check().is_err() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(serde_json::json!({
                "error": { "code": "RATE_LIMITED", "message": "Too many requests", "statusCode": 429 }
            })),
        ).into_response();
    }
    next.run(req).await
}
