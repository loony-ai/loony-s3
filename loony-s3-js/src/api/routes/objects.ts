import { Router } from 'express';
import { ObjectController } from '../controllers/ObjectController';
import { asyncHandler } from '../middleware/errorHandler';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { uploadRateLimiter, downloadRateLimiter } from '../middleware/rateLimiter';

export function createObjectRouter(controller: ObjectController): Router {
  const router = Router({ mergeParams: true });

  /**
   * POST /:bucket/:key?uploads              → initiate multipart
   * POST /:bucket/:key?uploadId=X           → complete multipart
   */
  router.post(
    '/:bucket/:key(*)',
    requireAuth,
    uploadRateLimiter,
    asyncHandler(async (req, res, next) => {
      if ('uploads' in req.query) {
        return controller.initiateMultipartUpload(req, res);
      }
      if (req.query['uploadId']) {
        return controller.completeMultipartUpload(req, res);
      }
      next();
    }),
  );

  /**
   * PUT /:bucket/:key                        → put object
   * PUT /:bucket/:key?partNumber=N&uploadId=X → upload part
   */
  router.put(
    '/:bucket/:key(*)',
    requireAuth,
    uploadRateLimiter,
    asyncHandler((req, res) => {
      if (req.query['uploadId'] && req.query['partNumber']) {
        return controller.uploadPart(req, res);
      }
      return controller.putObject(req, res);
    }),
  );

  /**
   * HEAD /:bucket/:key
   */
  router.head('/:bucket/:key(*)', optionalAuth, asyncHandler(controller.headObject));

  /**
   * GET /:bucket/:key  — dispatches internally on query params:
   *   ?list=true, ?list_versions=true, ?presign=true,
   *   ?uploadId=X, ?signature=X&expires=Y&operation=Z, (default) download
   */
  router.get(
    '/:bucket/:key(*)',
    optionalAuth,
    downloadRateLimiter,
    asyncHandler(controller.getObject),
  );

  /**
   * DELETE /:bucket/:key?uploadId=X → abort multipart
   * DELETE /:bucket/:key             → delete object
   */
  router.delete(
    '/:bucket/:key(*)',
    requireAuth,
    asyncHandler((req, res) => {
      if (req.query['uploadId']) {
        return controller.abortMultipartUpload(req, res);
      }
      return controller.deleteObject(req, res);
    }),
  );

  return router;
}
