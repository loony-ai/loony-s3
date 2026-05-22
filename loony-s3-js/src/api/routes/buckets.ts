import { Router } from 'express';
import { BucketController } from '../controllers/BucketController';
import { asyncHandler } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';

export function createBucketRouter(controller: BucketController): Router {
  const router = Router();

  // All bucket operations require authentication.
  router.use(requireAuth);

  /**
   * GET /buckets
   * List all buckets owned by the authenticated user.
   *
   * Response: { buckets: Bucket[], count: number }
   */
  router.get('/', asyncHandler(controller.listBuckets));

  /**
   * POST /buckets
   * Create a new bucket.
   *
   * Body: { name, acl?, region?, versioning?, metadata? }
   * Response: { bucket: Bucket }
   */
  router.post('/', asyncHandler(controller.createBucket));

  /**
   * GET /buckets/:name
   * Get bucket details.
   */
  router.get('/:name', asyncHandler(controller.getBucket));

  /**
   * PATCH /buckets/:name
   * Update bucket settings (ACL, versioning, metadata).
   */
  router.patch('/:name', asyncHandler(controller.updateBucket));

  /**
   * DELETE /buckets/:name
   * Delete a bucket. Add ?force=true to delete non-empty buckets.
   */
  router.delete('/:name', asyncHandler(controller.deleteBucket));

  return router;
}
