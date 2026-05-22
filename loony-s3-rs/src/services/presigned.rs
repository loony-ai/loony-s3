use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::error::{AppError, Result};
use crate::types::{PresignedOperation, PresignedUrl};

type HmacSha256 = Hmac<Sha256>;

pub struct PresignedService {
    secret: String,
}

impl PresignedService {
    pub fn new(secret: impl Into<String>) -> Self {
        Self { secret: secret.into() }
    }

    pub fn sign(
        &self,
        operation:   PresignedOperation,
        bucket_name: &str,
        key:         &str,
        expires_in:  u64,
    ) -> Result<PresignedUrl> {
        let expires_at = (Utc::now().timestamp() as u64)
            .checked_add(expires_in)
            .ok_or_else(|| AppError::Internal("timestamp overflow".into()))?;

        let payload = format!("{op}:{bucket}:{key}:{exp}",
            op     = operation,
            bucket = bucket_name,
            key    = key,
            exp    = expires_at,
        );

        let sig = sign_payload(&self.secret, &payload)?;

        Ok(PresignedUrl {
            bucket_name: bucket_name.to_string(),
            key:         key.to_string(),
            operation,
            expires_at,
            signature:   sig,
        })
    }

    pub fn validate(
        &self,
        operation:   &str,
        bucket_name: &str,
        key:         &str,
        expires_at:  u64,
        signature:   &str,
    ) -> Result<PresignedOperation> {
        let op: PresignedOperation = operation.parse()
            .map_err(|_| AppError::BadRequest(format!("Unknown operation: {operation}")))?;

        let now = Utc::now().timestamp() as u64;
        if now > expires_at {
            return Err(AppError::Unauthorized("Presigned URL has expired".into()));
        }

        let payload = format!("{op}:{bucket}:{key}:{exp}",
            op     = op,
            bucket = bucket_name,
            key    = key,
            exp    = expires_at,
        );

        let expected = sign_payload(&self.secret, &payload)?;

        if expected.as_bytes().ct_eq(signature.as_bytes()).into() {
            Ok(op)
        } else {
            Err(AppError::Unauthorized("Invalid signature".into()))
        }
    }
}

fn sign_payload(secret: &str, payload: &str) -> Result<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| AppError::Internal(e.to_string()))?;
    mac.update(payload.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}
