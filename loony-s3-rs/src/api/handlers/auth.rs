use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::api::auth::{issue_api_key, issue_jwt};
use crate::api::state::AppState;
use crate::error::Result;

#[derive(Deserialize)]
pub struct TokenRequest {
    pub user_id: String,
    pub name:    String,
}

#[derive(Serialize)]
pub struct TokenResponse {
    pub token:   String,
    pub api_key: String,
}

pub async fn issue_token(
    State(state): State<AppState>,
    Json(body): Json<TokenRequest>,
) -> Result<(StatusCode, Json<TokenResponse>)> {
    let expiry: u64 = state.config.auth.jwt_expiry.parse().unwrap_or(86400);

    let token = issue_jwt(&body.user_id, &body.name, &state.config.auth.jwt_secret, expiry)?;
    let api_key = issue_api_key(&body.user_id, &body.name);

    Ok((StatusCode::CREATED, Json(TokenResponse { token, api_key })))
}
