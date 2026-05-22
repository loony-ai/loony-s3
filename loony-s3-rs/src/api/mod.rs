use axum::{
    middleware as axum_mw,
    routing::{get, post},
    Router,
};

use crate::metrics;

pub mod auth;
pub mod handlers;
pub mod middleware;
pub mod state;

use handlers::{auth as auth_handler, bucket as bucket_handler, object as object_handler};
use middleware::rate_limit::new_limiter;
use middleware::request_id::request_id_middleware;
use state::AppState;

pub fn build_router(state: AppState) -> Router {
    let cfg = &state.config;

    let general_limiter = new_limiter(cfg.rate_limit.general_max);
    let auth_limiter    = new_limiter(cfg.rate_limit.auth_max);
    let gl = general_limiter.clone();
    let al = auth_limiter.clone();

    // POST /auth/token
    let auth_routes = Router::new()
        .route("/token", post(auth_handler::issue_token))
        .layer(axum_mw::from_fn(move |req, next| {
            middleware::rate_limit::rate_limit_middleware(al.clone(), req, next)
        }));

    // /buckets — bucket CRUD only; list-objects is via /:bucket/*key
    let bucket_routes = Router::new()
        .route("/",      get(bucket_handler::list_buckets).post(bucket_handler::create_bucket))
        .route("/:name", get(bucket_handler::get_bucket)
                            .put(bucket_handler::update_bucket)
                            .delete(bucket_handler::delete_bucket));

    // /:bucket/*key — all object + multipart operations.
    // Dispatch by HTTP method + query params (S3-compatible):
    //   GET  ?list=true                              → list objects in bucket
    //   GET  ?presign=true&operation=X&expires_in=N → generate presigned URL
    //   GET  ?list_versions=true                    → list object versions
    //   GET  ?uploadId=X                            → list multipart parts
    //   GET  (signature/expires/operation present)  → consume presigned URL
    //   GET  (default)                              → stream object body
    //   PUT  ?partNumber=N&uploadId=X               → upload multipart part
    //   PUT  (default)                              → put object
    //   POST ?uploads                               → initiate multipart
    //   POST ?uploadId=X                            → complete multipart
    //   DELETE ?uploadId=X                          → abort multipart
    //   DELETE (default)                            → delete object
    let object_routes = Router::new()
        .route("/:bucket/*key",
            get(object_handler::get_object)
                .put(object_handler::put_object)
                .post(object_handler::post_object)
                .delete(object_handler::delete_object));

    Router::new()
        .route("/metrics", get(|| async { axum::Json(metrics::snapshot()) }))
        .route("/health",  get(|| async { axum::Json(serde_json::json!({ "status": "ok" })) }))
        .nest("/auth",    auth_routes)
        .nest("/buckets", bucket_routes)
        .merge(object_routes)
        .layer(axum_mw::from_fn(move |req, next| {
            middleware::rate_limit::rate_limit_middleware(gl.clone(), req, next)
        }))
        .layer(axum_mw::from_fn(request_id_middleware))
        .with_state(state)
}
