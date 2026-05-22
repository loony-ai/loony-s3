import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { signJwt } from '../middleware/auth';

/**
 * MVP auth endpoint — issues JWTs for a given email/password pair.
 * In production this would validate against a user store with hashed passwords.
 *
 * For quick testing, any password is accepted and a synthetic userId is derived
 * from the email so requests from the same email get the same userId.
 */
const TokenSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function createAuthRouter(): Router {
  const router = Router();

  /**
   * POST /auth/token
   * Body: { email, password }
   * Response: { token, expiresIn, userId }
   *
   * Usage in requests:
   *   Authorization: Bearer <token>
   */
  router.post('/token', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = TokenSchema.parse(req.body);

      // Deterministic userId from email so it's stable across restarts in dev.
      const userId = uuidv4({ random: Buffer.from(email.padEnd(16, '0').slice(0, 16)) });

      const token = signJwt({ id: userId, email });

      res.json({ token, expiresIn: '24h', userId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /auth/apikey
   * Returns a base64-encoded API key for the authenticated user.
   * Authorization: Bearer <jwt>
   */
  router.get('/apikey', (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Provide a Bearer token' } });
        return;
      }
      // Re-use the JWT validation from the auth middleware inline.
      const jwt = require('jsonwebtoken');
      const { config } = require('../../config');
      const payload = jwt.verify(auth.slice(7), config.auth.jwtSecret);
      const apiKey = Buffer.from(`${payload.sub}:${payload.email}`).toString('base64');
      res.json({ apiKey });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
