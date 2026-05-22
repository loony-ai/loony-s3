use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use serde::Serialize;
use std::collections::HashMap;

use crate::api::auth::{AuthUser, OptionalAuth};
use crate::api::state::AppState;
use crate::error::{AppError, Result};
use crate::services::object::PutObjectOptions;
use crate::types::{ListObjectsQuery, ObjectAcl, StoredObject};

// ── helpers ───────────────────────────────────────────────────────────────────

fn object_response(obj: &StoredObject) -> impl Serialize + '_ {
    #[derive(Serialize)]
    struct R<'a> {
        id:          &'a str,
        bucket_name: &'a str,
        key:         &'a str,
        size:        i64,
        mime_type:   &'a str,
        etag:        &'a str,
        acl:         String,
        version_id:  &'a str,
        is_latest:   bool,
        metadata:    &'a HashMap<String, String>,
        created_at:  String,
        updated_at:  String,
        expires_at:  Option<String>,
    }
    R {
        id:          &obj.id,
        bucket_name: &obj.bucket_name,
        key:         &obj.key,
        size:        obj.size,
        mime_type:   &obj.mime_type,
        etag:        &obj.etag,
        acl:         obj.acl.to_string(),
        version_id:  &obj.version_id,
        is_latest:   obj.is_latest,
        metadata:    &obj.metadata,
        created_at:  obj.created_at.to_rfc3339(),
        updated_at:  obj.updated_at.to_rfc3339(),
        expires_at:  obj.expires_at.map(|d| d.to_rfc3339()),
    }
}

fn parse_range(header_val: Option<&str>, file_size: u64) -> Result<Option<(u64, u64)>> {
    let val = match header_val {
        Some(v) => v,
        None    => return Ok(None),
    };
    let stripped = val.strip_prefix("bytes=")
        .ok_or_else(|| AppError::BadRequest("Invalid Range header".into()))?;
    let mut parts = stripped.splitn(2, '-');
    let start: u64 = parts.next().unwrap_or("0").parse()
        .map_err(|_| AppError::BadRequest("Invalid Range header".into()))?;
    let end: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(file_size - 1);
    Ok(Some((start, end)))
}

// ── PUT /:bucket/:key — dispatch on query params ──────────────────────────────
//   ?partNumber=N&uploadId=X → upload multipart part
//   (default)                → put object

pub async fn put_object(
    State(state): State<AppState>,
    user: AuthUser,
    Path((bucket_name, key)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response> {
    // Multipart part upload
    if let (Some(upload_id), Some(part_str)) = (params.get("uploadId"), params.get("partNumber")) {
        let part_number: i32 = part_str.parse()
            .map_err(|_| AppError::BadRequest("Invalid partNumber".into()))?;
        let stream = Box::pin(
            body.into_data_stream()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        );
        let part = state.multipart_svc.upload_part(upload_id, part_number, stream).await?;
        return Ok(axum::Json(serde_json::json!({
            "partNumber": part.part_number,
            "etag": part.etag,
            "size": part.size,
        })).into_response());
    }

    let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
    state.bucket_svc.assert_write_access(&bucket, Some(&user.id))?;

    let content_type = headers.get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let size_hint = headers.get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let acl_str = headers.get("x-amz-acl")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("private");
    let acl: ObjectAcl = acl_str.parse().unwrap_or(ObjectAcl::Private);

    let ttl_seconds = headers.get("x-ttl-seconds")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok());

    let metadata: HashMap<String, String> = headers.iter()
        .filter_map(|(k, v)| {
            let name = k.as_str();
            if name.starts_with("x-amz-meta-") {
                let meta_key = name["x-amz-meta-".len()..].to_string();
                v.to_str().ok().map(|val| (meta_key, val.to_string()))
            } else {
                None
            }
        })
        .collect();

    let stream = Box::pin(
        body.into_data_stream()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    );

    let opts = PutObjectOptions { content_type, acl, metadata, ttl_seconds, size_hint };
    let obj = state.object_svc
        .put_object(&bucket.id, &bucket_name, &key, stream, opts)
        .await?;

    Ok((StatusCode::CREATED, Json(serde_json::to_value(object_response(&obj)).unwrap())).into_response())
}

// ── GET /:bucket/:key ─────────────────────────────────────────────────────────
//
// Dispatch via query params:
//   ?presign=true&operation=GET&expires_in=3600  → generate presigned URL
//   ?list_versions=true                          → list all versions of this key
//   ?signature=...&expires=...&operation=...     → consume a presigned URL
//   (default)                                    → stream the object body

pub async fn get_object(
    State(state): State<AppState>,
    auth: OptionalAuth,
    Path((bucket_name, key)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response> {
    // ── List objects ──────────────────────────────────────────────────────────
    if params.get("list").map(String::as_str) == Some("true") {
        let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
        state.bucket_svc.assert_read_access(&bucket, auth.0.as_ref().map(|u| u.id.as_str()))?;
        return list_objects_impl(&state, auth, &bucket_name, params).await.map(|j| j.into_response());
    }

    // ── Presign generation ────────────────────────────────────────────────────
    if params.get("presign").map(String::as_str) == Some("true") {
        let user = auth.0.ok_or_else(|| AppError::Unauthorized("Auth required to generate presigned URL".into()))?;
        let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
        state.bucket_svc.assert_write_access(&bucket, Some(&user.id))?;

        let op_str = params.get("operation").map(String::as_str).unwrap_or("GET");
        let op: crate::types::PresignedOperation = op_str.parse()
            .map_err(|_| AppError::BadRequest(format!("Unknown operation: {op_str}")))?;
        let max_expiry = state.config.presigned.max_expiry_seconds;
        let expires_in = params.get("expires_in").and_then(|v| v.parse::<u64>().ok()).unwrap_or(3600).min(max_expiry);

        let url = state.presigned_svc.sign(op, &bucket_name, &key, expires_in)?;
        let base = &state.config.base_url;
        let link = format!(
            "{base}/{bucket_name}/{key}?operation={op}&expires={exp}&signature={sig}",
            op  = url.operation,
            exp = url.expires_at,
            sig = url.signature,
        );
        return Ok(axum::Json(serde_json::json!({ "url": link, "expiresAt": url.expires_at })).into_response());
    }

    // ── Version listing ───────────────────────────────────────────────────────
    if params.get("list_versions").map(String::as_str) == Some("true") {
        let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
        state.bucket_svc.assert_read_access(&bucket, auth.0.as_ref().map(|u| u.id.as_str()))?;
        let versions = state.object_svc.list_versions(&bucket.id, &key).await?;
        let body = serde_json::json!({
            "versions": versions.iter().map(|o| serde_json::to_value(object_response(o)).unwrap()).collect::<Vec<_>>()
        });
        return Ok(axum::Json(body).into_response());
    }

    // ── List multipart parts ──────────────────────────────────────────────────
    if let Some(upload_id) = params.get("uploadId").cloned() {
        let (upload, parts) = state.multipart_svc.list_parts(&upload_id).await?;
        return Ok(axum::Json(serde_json::json!({
            "uploadId": upload.upload_id,
            "key":      upload.key,
            "parts":    parts,
        })).into_response());
    }

    // ── Presigned URL consumption ─────────────────────────────────────────────
    if let (Some(sig), Some(exp), Some(op)) = (
        params.get("signature"),
        params.get("expires"),
        params.get("operation"),
    ) {
        let exp_u64: u64 = exp.parse().unwrap_or(0);
        state.presigned_svc.validate(op, &bucket_name, &key, exp_u64, sig)?;
    } else {
        let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
        state.bucket_svc.assert_read_access(&bucket, auth.0.as_ref().map(|u| u.id.as_str()))?;
    }

    // ── Normal GET ────────────────────────────────────────────────────────────
    let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
    let version_id = params.get("version_id").map(String::as_str);
    let obj = state.object_svc.get_object(&bucket.id, &key, version_id).await?;

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let range = parse_range(range_header, obj.size as u64)?;

    let (status, content_length) = if let Some((start, end)) = range {
        (StatusCode::PARTIAL_CONTENT, end - start + 1)
    } else {
        (StatusCode::OK, obj.size as u64)
    };

    let stream = state.object_svc.stream_object(&obj.storage_key, range).await?;

    use std::sync::atomic::Ordering;
    crate::metrics::METRICS.storage_bytes_downloaded.fetch_add(content_length, Ordering::Relaxed);

    let body = Body::from_stream(stream);

    let mut resp = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, &obj.mime_type)
        .header(header::CONTENT_LENGTH, content_length)
        .header(header::ETAG, format!("\"{}\"", obj.etag))
        .header("x-version-id", &obj.version_id);

    if let Some((start, end)) = range {
        resp = resp.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}", size = obj.size),
        );
    }

    Ok(resp.body(body).unwrap().into_response())
}

// ── HEAD /:bucket/:key ────────────────────────────────────────────────────────

pub async fn head_object(
    State(state): State<AppState>,
    auth: OptionalAuth,
    Path((bucket_name, key)): Path<(String, String)>,
) -> Result<Response> {
    let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
    state.bucket_svc.assert_read_access(&bucket, auth.0.as_ref().map(|u| u.id.as_str()))?;

    let obj = state.object_svc.head_object(&bucket.id, &key).await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, &obj.mime_type)
        .header(header::CONTENT_LENGTH, obj.size)
        .header(header::ETAG, format!("\"{}\"", obj.etag))
        .header("x-version-id", &obj.version_id)
        .body(Body::empty())
        .unwrap())
}

// ── POST /:bucket/:key — dispatch on query params ─────────────────────────────
//   ?uploads           → initiate multipart
//   ?uploadId=X (body) → complete multipart

pub async fn post_object(
    State(state): State<AppState>,
    user: AuthUser,
    Path((bucket_name, key)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response> {
    if params.contains_key("uploads") {
        // Initiate multipart
        let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
        state.bucket_svc.assert_write_access(&bucket, Some(&user.id))?;

        let metadata: HashMap<String, String> = headers.iter()
            .filter_map(|(k, v)| {
                let name = k.as_str();
                name.strip_prefix("x-amz-meta-")
                    .map(|mk| (mk.to_string(), v.to_str().unwrap_or("").to_string()))
            })
            .collect();

        let upload = state.multipart_svc.initiate(&bucket.id, &bucket_name, &key, &user.id, metadata).await?;
        return Ok(axum::Json(serde_json::json!({
            "uploadId":   upload.upload_id,
            "bucketName": upload.bucket_name,
            "key":        upload.key,
        })).into_response());
    }

    if let Some(upload_id) = params.get("uploadId").cloned() {
        // Complete multipart — body is JSON { parts: [i32], content_type?, acl?, ttl_seconds? }
        let body_bytes = axum::body::to_bytes(body, usize::MAX).await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
        let payload: serde_json::Value = serde_json::from_slice(&body_bytes)
            .unwrap_or_default();

        let part_numbers: Vec<i32> = serde_json::from_value(
            payload.get("parts").cloned().unwrap_or(serde_json::Value::Array(vec![]))
        ).unwrap_or_default();

        let acl: ObjectAcl = payload.get("acl")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(ObjectAcl::Private);

        let obj = state.multipart_svc.complete(
            &upload_id,
            part_numbers,
            payload.get("content_type").and_then(|v| v.as_str()).map(String::from),
            acl,
            payload.get("ttl_seconds").and_then(|v| v.as_i64()),
        ).await?;

        return Ok(axum::Json(serde_json::to_value(object_response(&obj)).unwrap()).into_response());
    }

    Err(AppError::BadRequest("POST requires ?uploads or ?uploadId query parameter".into()))
}

// ── DELETE /:bucket/:key — dispatch on query params ───────────────────────────
//   ?uploadId=X  → abort multipart
//   (default)    → delete object

pub async fn delete_object(
    State(state): State<AppState>,
    user: AuthUser,
    Path((bucket_name, key)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<StatusCode> {
    if let Some(upload_id) = params.get("uploadId").cloned() {
        state.multipart_svc.abort(&upload_id).await?;
        return Ok(StatusCode::NO_CONTENT);
    }

    let bucket = state.bucket_svc.get_bucket(&bucket_name).await?;
    state.bucket_svc.assert_write_access(&bucket, Some(&user.id))?;

    let version_id = params.get("version_id").map(String::as_str);
    state.object_svc.delete_object(&bucket.id, &key, version_id).await?;

    Ok(StatusCode::NO_CONTENT)
}

// ── GET /buckets/:name/objects — list objects ─────────────────────────────────

pub async fn list_objects_by_bucket_name(
    State(state): State<AppState>,
    auth: OptionalAuth,
    Path(bucket_name): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>> {
    list_objects_impl(&state, auth, &bucket_name, params).await
}

pub async fn list_objects(
    State(state): State<AppState>,
    auth: OptionalAuth,
    Path(bucket_name): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>> {
    list_objects_impl(&state, auth, &bucket_name, params).await
}

async fn list_objects_impl(
    state:       &AppState,
    auth:        OptionalAuth,
    bucket_name: &str,
    params:      HashMap<String, String>,
) -> Result<Json<serde_json::Value>> {
    let bucket = state.bucket_svc.get_bucket(bucket_name).await?;
    state.bucket_svc.assert_read_access(&bucket, auth.0.as_ref().map(|u| u.id.as_str()))?;

    let q = ListObjectsQuery {
        prefix:             params.get("prefix").cloned(),
        delimiter:          params.get("delimiter").cloned(),
        max_keys:           params.get("max_keys").and_then(|v| v.parse().ok()),
        continuation_token: params.get("continuation_token").cloned(),
    };

    let result = state.object_svc.list_objects(&bucket.id, &q).await?;

    Ok(Json(serde_json::json!({
        "objects":               result.objects.iter().map(|o| serde_json::to_value(object_response(o)).unwrap()).collect::<Vec<_>>(),
        "commonPrefixes":        result.common_prefixes,
        "isTruncated":           result.is_truncated,
        "nextContinuationToken": result.next_continuation_token,
        "keyCount":              result.key_count,
    })))
}

