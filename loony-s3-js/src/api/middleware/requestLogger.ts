import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.path}`, {
      status: res.statusCode,
      ms,
      ip: req.ip,
      user: req.user?.id,
      reqId: req.requestId,
    });
  });

  next();
}
