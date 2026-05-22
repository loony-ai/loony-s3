import { v4 as uuidv4 } from 'uuid';
import { Bucket, CreateBucketRequest, UpdateBucketRequest } from '../types';
import { IBucketRepository, IObjectRepository } from '../repositories/interfaces';
import { AppError } from '../utils/AppError';

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export class BucketService {
  constructor(
    private readonly bucketRepo: IBucketRepository,
    private readonly objectRepo: IObjectRepository,
  ) {}

  async listBuckets(ownerId: string): Promise<Bucket[]> {
    return this.bucketRepo.listByOwner(ownerId);
  }

  async getBucket(name: string, requesterId: string): Promise<Bucket> {
    const bucket = await this.bucketRepo.findByName(name);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${name}' not found`);
    this.assertReadAccess(bucket, requesterId);
    return bucket;
  }

  async createBucket(req: CreateBucketRequest, ownerId: string): Promise<Bucket> {
    this.validateBucketName(req.name);

    if (await this.bucketRepo.existsByName(req.name)) {
      throw new AppError('BUCKET_ALREADY_EXISTS', `Bucket '${req.name}' already exists`);
    }

    const now = new Date();
    const bucket: Bucket = {
      id: uuidv4(),
      name: req.name,
      ownerId,
      acl: req.acl ?? 'private',
      region: req.region ?? 'us-east-1',
      versioning: req.versioning ?? false,
      metadata: req.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    return this.bucketRepo.create(bucket);
  }

  async updateBucket(name: string, req: UpdateBucketRequest, requesterId: string): Promise<Bucket> {
    const bucket = await this.bucketRepo.findByName(name);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${name}' not found`);
    this.assertOwner(bucket, requesterId);
    return this.bucketRepo.update(bucket.id, req);
  }

  async deleteBucket(name: string, requesterId: string, force = false): Promise<void> {
    const bucket = await this.bucketRepo.findByName(name);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${name}' not found`);
    this.assertOwner(bucket, requesterId);

    const objectCount = await this.objectRepo.countInBucket(bucket.id);
    if (objectCount > 0 && !force) {
      throw new AppError(
        'BUCKET_NOT_EMPTY',
        `Bucket '${name}' is not empty (${objectCount} objects). ` +
          'Use ?force=true to delete a non-empty bucket.',
      );
    }

    await this.bucketRepo.delete(bucket.id);
  }

  // ─── Access helpers (synchronous — no I/O needed) ─────────────────────────

  assertReadAccess(bucket: Bucket, requesterId: string): void {
    if (bucket.acl === 'private' && bucket.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', `Access denied to bucket '${bucket.name}'`);
    }
  }

  assertWriteAccess(bucket: Bucket, requesterId: string): void {
    if (bucket.acl !== 'public-read-write' && bucket.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', `Write access denied to bucket '${bucket.name}'`);
    }
  }

  assertOwner(bucket: Bucket, requesterId: string): void {
    if (bucket.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', 'Only the bucket owner can perform this action');
    }
  }

  private validateBucketName(name: string): void {
    if (!BUCKET_NAME_RE.test(name)) {
      throw new AppError(
        'INVALID_BUCKET_NAME',
        `Invalid bucket name '${name}'. Must be 3-63 lowercase alphanumeric/hyphen/dot characters.`,
      );
    }
    if (name.includes('..') || name.includes('.-') || name.includes('-.')) {
      throw new AppError('INVALID_BUCKET_NAME', `Bucket name '${name}' contains invalid sequences.`);
    }
  }
}
