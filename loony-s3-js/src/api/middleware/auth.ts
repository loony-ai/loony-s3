import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedUser, JwtPayload } from '../../types';
import { AppError } from '../../utils/AppError';
import { config } from '../../config';

/**
 * Strict auth — rejects unauthenticated requests.
 * Supports two schemes:
 *   Authorization: Bearer <jwt>
 *   Authorization: ApiKey <raw-token>     (future: look up in DB)
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    req.user = extractUser(req);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Optional auth — populates req.user if a valid token is present, but does not
 * reject the request if no token is provided (public endpoints).
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    req.user = extractUser(req);
  } catch {
    // intentionally swallowed
  }
  next();
}

function extractUser(req: Request): AuthenticatedUser {
  const header = req.headers.authorization;
  if (!header) {
    throw new AppError('UNAUTHORIZED', 'No authorization header');
  }

  const [scheme, token] = header.split(' ', 2);

  if (scheme === 'Bearer' && token) {
    return verifyJwt(token);
  }

  if (scheme === 'ApiKey' && token) {
    return verifyApiKey(token);
  }

  throw new AppError('UNAUTHORIZED', 'Unsupported authorization scheme');
}

function verifyJwt(token: string): AuthenticatedUser {
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError('UNAUTHORIZED', 'Token expired');
    }
    throw new AppError('UNAUTHORIZED', 'Invalid token');
  }
  return { id: payload.sub, name: payload.name };
}

/** Format: base64("{user_id}:{name}") */
function verifyApiKey(rawKey: string): AuthenticatedUser {
  try {
    const decoded = Buffer.from(rawKey, 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) throw new Error('bad format');
    const id = decoded.slice(0, colonIdx);
    const name = decoded.slice(colonIdx + 1);
    if (!id || !name) throw new Error('bad format');
    return { id, name };
  } catch {
    throw new AppError('UNAUTHORIZED', 'Invalid API key');
  }
}

/** Helper to issue a JWT — used by the /auth/token endpoint. */
export function signJwt(user: { id: string; name: string }): string {
  return jwt.sign(
    { sub: user.id, name: user.name },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiry } as jwt.SignOptions,
  );
}
