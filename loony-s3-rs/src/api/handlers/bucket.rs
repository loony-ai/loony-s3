use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::api::auth::{AuthUser, OptionalAuth};
use crate::api::state::AppState;
use crate::error::Result;
use crate::types::BucketAcl;

// ── Request / response bodies ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateBucketBody {
    pub name:   String,
    pub acl:    Option<String>,
    pub region: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateBucketBody {
    pub acl:        Option<String>,
    pub versioning: Option<bool>,
    pub metadata:   Option<HashMap<String, String>>,
}

#[derive(Serialize)]
pub struct BucketResponse {
    pub id:         String,
    pub name:       String,
    pub acl:        String,
    pub region:     String,
    pub versioning: bool,
    pub owner_id:   String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<crate::types::Bucket> for BucketResponse {
    fn from(b: crate::types::Bucket) -> Self {
        BucketResponse {
            id:         b.id,
            name:       b.name,
            acl:        b.acl.to_string(),
            region:     b.region,
            versioning: b.versioning,
            owner_id:   b.owner_id,
            created_at: b.created_at.to_rfc3339(),
            updated_at: b.updated_at.to_rfc3339(),
        }
    }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn create_bucket(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateBucketBody>,
) -> Result<(StatusCode, Json<BucketResponse>)> {
    let acl = body.acl.as_deref()
        .map(|s| s.parse::<BucketAcl>().unwrap_or(BucketAcl::Private))
        .unwrap_or(BucketAcl::Private);

    let bucket = state.bucket_svc
        .create_bucket(&body.name, &user.id, acl, body.region)
        .await?;

    Ok((StatusCode::CREATED, Json(bucket.into())))
}

pub async fn list_buckets(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<BucketResponse>>> {
    let buckets = state.bucket_svc.list_buckets(&user.id).await?;
    Ok(Json(buckets.into_iter().map(Into::into).collect()))
}

pub async fn get_bucket(
    State(state): State<AppState>,
    auth: OptionalAuth,
    Path(name): Path<String>,
) -> Result<Json<BucketResponse>> {
    let bucket = state.bucket_svc.get_bucket(&name).await?;
    state.bucket_svc.assert_read_access(&bucket, auth.0.as_ref().map(|u| u.id.as_str()))?;
    Ok(Json(bucket.into()))
}

pub async fn update_bucket(
    State(state): State<AppState>,
    user: AuthUser,
    Path(name): Path<String>,
    Json(body): Json<UpdateBucketBody>,
) -> Result<Json<BucketResponse>> {
    let acl_parsed: Option<BucketAcl> = body.acl.as_deref()
        .map(|s| s.parse().unwrap_or(BucketAcl::Private));

    let bucket = state.bucket_svc.update_bucket(
        &name,
        &user.id,
        acl_parsed.as_ref(),
        body.versioning,
        body.metadata.as_ref(),
    ).await?;

    Ok(Json(bucket.into()))
}

pub async fn delete_bucket(
    State(state): State<AppState>,
    user: AuthUser,
    Path(name): Path<String>,
) -> Result<StatusCode> {
    state.bucket_svc.delete_bucket(&name, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}
