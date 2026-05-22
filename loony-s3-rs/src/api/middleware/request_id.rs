use axum::{
    extract::Request,
    http::HeaderValue,
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

pub async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let id = req.headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    req.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&id).unwrap_or_else(|_| HeaderValue::from_static("unknown")),
    );

    let mut resp = next.run(req).await;
    if let Ok(val) = HeaderValue::from_str(&id) {
        resp.headers_mut().insert("x-request-id", val);
    }
    resp
}
