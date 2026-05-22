import { Request, Response } from 'express';
import { z } from 'zod';
import { BucketService } from '../../services/BucketService';
import { AppError } from '../../utils/AppError';

const CreateBucketSchema = z.object({
  name: z.string().min(3).max(63),
  acl: z.enum(['private', 'public-read', 'public-read-write']).optional(),
  region: z.string().optional(),
  versioning: z.boolean().optional(),
  metadata: z.record(z.string()).optional(),
});

const UpdateBucketSchema = z.object({
  acl: z.enum(['private', 'public-read', 'public-read-write']).optional(),
  versioning: z.boolean().optional(),
  metadata: z.record(z.string()).optional(),
});

export class BucketController {
  constructor(private readonly bucketService: BucketService) {}

  listBuckets = async (req: Request, res: Response): Promise<void> => {
    const user = this.assertAuth(req);
    const buckets = await this.bucketService.listBuckets(user.id);
    res.json({ buckets, count: buckets.length });
  };

  getBucket = async (req: Request, res: Response): Promise<void> => {
    const user = this.assertAuth(req);
    const bucket = await this.bucketService.getBucket(req.params['name']!, user.id);
    res.json({ bucket });
  };

  createBucket = async (req: Request, res: Response): Promise<void> => {
    const user = this.assertAuth(req);
    const body = CreateBucketSchema.parse(req.body);
    const bucket = await this.bucketService.createBucket(body, user.id);
    res.status(201).json({ bucket });
  };

  updateBucket = async (req: Request, res: Response): Promise<void> => {
    const user = this.assertAuth(req);
    const body = UpdateBucketSchema.parse(req.body);
    const bucket = await this.bucketService.updateBucket(req.params['name']!, body, user.id);
    res.json({ bucket });
  };

  deleteBucket = async (req: Request, res: Response): Promise<void> => {
    const user = this.assertAuth(req);
    const force = req.query['force'] === 'true';
    await this.bucketService.deleteBucket(req.params['name']!, user.id, force);
    res.status(204).end();
  };

  private assertAuth(req: Request) {
    if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required');
    return req.user;
  }
}
