import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { signJwt } from '../middleware/auth';

/**
 * POST /auth/token
 * Body: { user_id, name }
 * Response: { token, api_key }
 */
const TokenSchema = z.object({
  user_id: z.string().min(1),
  name: z.string().min(1),
});

export function createAuthRouter(): Router {
  const router = Router();

  router.post('/token', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id, name } = TokenSchema.parse(req.body);

      const token = signJwt({ id: user_id, name });
      const api_key = Buffer.from(`${user_id}:${name}`).toString('base64');

      res.json({ token, api_key });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
