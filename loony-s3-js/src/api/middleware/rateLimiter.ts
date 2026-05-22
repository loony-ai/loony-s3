import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../../config';

const { windowMs, auth, upload, download, general } = config.rateLimit;

// Auth endpoints — strict to slow credential stuffing.
export const authRateLimiter = rateLimit({
  windowMs,
  limit: auth.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many auth requests, try again later' } },
});

// Write endpoints (PUT / POST) — per authenticated user or IP.
export const uploadRateLimiter = rateLimit({
  windowMs,
  limit: upload.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  message: { error: { code: 'RATE_LIMITED', message: 'Upload rate limit exceeded' } },
});

// Read endpoints — generous, keyed per user or IP.
export const downloadRateLimiter = rateLimit({
  windowMs,
  limit: download.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  message: { error: { code: 'RATE_LIMITED', message: 'Download rate limit exceeded' } },
});

// Catch-all for anything not covered above.
export const generalRateLimiter = rateLimit({
  windowMs,
  limit: general.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  message: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
});
