import { Router } from 'express';
import { ObjectController } from '../controllers/ObjectController';
import { asyncHandler } from '../middleware/errorHandler';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { uploadRateLimiter, downloadRateLimiter } from '../middleware/rateLimiter';

export function createObjectRouter(controller: ObjectController): Router {
  const router = Router({ mergeParams: true });

  // ─── Pre-signed URL handler (no auth required — signature is the credential) ──
  /**
   * GET|PUT|DELETE /presigned/:bucket/:key
   */
  router.all(
    '/presigned/:bucket/:key(*)',
    asyncHandler(controller.handlePresignedRequest),
  );

  // ─── All other object routes require authentication ─────────────────────────

  /**
   * GET /:bucket  (list objects)
   * Query params: prefix, delimiter, maxKeys, continuationToken
   */
  router.get('/:bucket', requireAuth, asyncHandler(controller.listObjects));

  /**
   * POST /:bucket/presign
   * Generate a presigned URL.
   * Body: { key, operation, expiresInSeconds, metadata? }
   */
  router.post('/:bucket/presign', requireAuth, asyncHandler(controller.generatePresignedUrl));

  /**
   * POST /:bucket/:key?uploads
   * Initiate multipart upload.
   */
  router.post(
    '/:bucket/:key(*)',
    requireAuth,
    uploadRateLimiter,
    asyncHandler(async (req, res, next) => {
      // Route based on query params to disambiguate POST actions.
      if ('uploads' in req.query) {
        return controller.initiateMultipartUpload(req, res);
      }
      if (req.query['uploadId'] && !('parts' in req.query)) {
        return controller.completeMultipartUpload(req, res);
      }
      next();
    }),
  );

  /**
   * PUT /:bucket/:key
   * Single-part upload.
   *
   * PUT /:bucket/:key?partNumber=N&uploadId=X
   * Upload a part.
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
  router.head('/:bucket/:key(*)', requireAuth, asyncHandler(controller.headObject));

  /**
   * GET /:bucket/:key?parts=true&uploadId=X  (list parts)
   * GET /:bucket/:key                         (download object)
   */
  router.get(
    '/:bucket/:key(*)',
    optionalAuth,  // public objects can be accessed without auth
    downloadRateLimiter,
    asyncHandler((req, res) => {
      if ('parts' in req.query && req.query['uploadId']) {
        return controller.listParts(req, res);
      }
      return controller.getObject(req, res);
    }),
  );

  /**
   * DELETE /:bucket/:key?versionId=X        (delete specific version)
   * DELETE /:bucket/:key?uploadId=X         (abort multipart)
   * DELETE /:bucket/:key                    (delete latest version)
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
