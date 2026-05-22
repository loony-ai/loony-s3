import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  // Honour an incoming ID (e.g. from nginx's $request_id) so the same ID
  // flows through nginx logs, app logs, and client responses end-to-end.
  const id = (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
