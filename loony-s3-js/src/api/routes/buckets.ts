import { Router } from 'express';
import { BucketController } from '../controllers/BucketController';
import { asyncHandler } from '../middleware/errorHandler';
import { requireAuth, optionalAuth } from '../middleware/auth';

export function createBucketRouter(controller: BucketController): Router {
  const router = Router();

  router.get('/', requireAuth, asyncHandler(controller.listBuckets));
  router.post('/', requireAuth, asyncHandler(controller.createBucket));

  // GET with optional auth so public-read buckets are accessible without a token.
  router.get('/:name', optionalAuth, asyncHandler(controller.getBucket));

  // Accept both PATCH and PUT for compatibility.
  router.patch('/:name', requireAuth, asyncHandler(controller.updateBucket));
  router.put('/:name', requireAuth, asyncHandler(controller.updateBucket));

  router.delete('/:name', requireAuth, asyncHandler(controller.deleteBucket));

  return router;
}
