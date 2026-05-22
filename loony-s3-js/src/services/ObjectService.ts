import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import path from 'path';
import { StoredObject, ObjectACL, ListObjectsQuery, ListObjectsResult } from '../types';
import { IBucketRepository, IObjectRepository } from '../repositories/interfaces';
import { StorageBackend } from '../storage/StorageBackend';
import { BucketService } from './BucketService';
import { AppError } from '../utils/AppError';
import { config } from '../config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

interface PutObjectOptions {
  bucketName: string;
  key: string;
  stream: Readable;
  mimeType?: string;
  contentLength?: number;
  acl?: ObjectACL;
  metadata?: Record<string, string>;
  requesterId: string;
  ttlSeconds?: number;
}

interface GetObjectResult {
  object: StoredObject;
  stream: Readable;
}

interface GetObjectOptions {
  bucketName: string;
  key: string;
  versionId?: string;
  range?: { start: number; end?: number };
  requesterId: string;
}

export class ObjectService {
  constructor(
    private readonly bucketRepo: IBucketRepository,
    private readonly objectRepo: IObjectRepository,
    private readonly storageBackend: StorageBackend,
    private readonly bucketService: BucketService,
  ) {}

  async putObject(opts: PutObjectOptions): Promise<StoredObject> {
    const bucket = await this.bucketRepo.findByName(opts.bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${opts.bucketName}' not found`);

    this.bucketService.assertWriteAccess(bucket, opts.requesterId);
    this.validateObjectKey(opts.key);

    if (opts.contentLength && opts.contentLength > config.upload.maxObjectSizeBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'Object exceeds maximum allowed size');
    }

    const versionId = uuidv4().replace(/-/g, '');
    const shard = versionId.slice(0, 2);
    const storageKey = path.posix.join(opts.bucketName, shard, versionId);
    const resolvedMime = opts.mimeType ?? (mime.lookup(opts.key) || 'application/octet-stream');

    logger.debug('Writing object to storage', { storageKey, key: opts.key });

    const info = await this.storageBackend.write(storageKey, opts.stream, opts.contentLength);

    const now = new Date();
    const obj: StoredObject = {
      id: uuidv4(),
      bucketId: bucket.id,
      bucketName: bucket.name,
      key: opts.key,
      size: info.size,
      mimeType: resolvedMime,
      etag: info.etag,
      storageKey: info.storageKey,
      acl: opts.acl ?? 'private',
      versionId,
      isLatest: true,
      metadata: opts.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      expiresAt: opts.ttlSeconds ? new Date(now.getTime() + opts.ttlSeconds * 1000) : undefined,
    };

    const created = await this.objectRepo.create(obj);
    metrics.objects.created++;
    metrics.storage.bytesUploaded += info.size;
    return created;
  }

  async getObject(opts: GetObjectOptions): Promise<GetObjectResult> {
    const bucket = await this.bucketRepo.findByName(opts.bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${opts.bucketName}' not found`);

    this.bucketService.assertReadAccess(bucket, opts.requesterId);

    const obj = opts.versionId
      ? (await this.objectRepo.findVersions(bucket.id, opts.key)).find(
          (v) => v.versionId === opts.versionId,
        )
      : await this.objectRepo.findLatest(bucket.id, opts.key);

    if (!obj) throw new AppError('OBJECT_NOT_FOUND', `Object '${opts.key}' not found`);

    if (obj.expiresAt && obj.expiresAt < new Date()) {
      throw new AppError('OBJECT_EXPIRED', `Object '${opts.key}' has expired`);
    }

    if (obj.acl === 'private' && bucket.ownerId !== opts.requesterId) {
      throw new AppError('ACCESS_DENIED', 'Access denied');
    }

    const stream = await this.storageBackend.read(obj.storageKey, opts.range);
    metrics.storage.bytesDownloaded += obj.size;
    return { object: obj, stream };
  }

  async headObject(bucketName: string, key: string, requesterId: string): Promise<StoredObject> {
    const { object } = await this.getObject({ bucketName, key, requesterId });
    return object;
  }

  async listObjects(
    bucketName: string,
    query: ListObjectsQuery,
    requesterId: string,
  ): Promise<ListObjectsResult> {
    const bucket = await this.bucketRepo.findByName(bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${bucketName}' not found`);
    this.bucketService.assertReadAccess(bucket, requesterId);
    return this.objectRepo.list(bucket.id, query);
  }

  async deleteObject(
    bucketName: string,
    key: string,
    requesterId: string,
    versionId?: string,
  ): Promise<void> {
    const bucket = await this.bucketRepo.findByName(bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${bucketName}' not found`);
    this.bucketService.assertWriteAccess(bucket, requesterId);

    const storageKeys = await this.objectRepo.hardDelete(bucket.id, key, versionId);
    if (storageKeys.length === 0) {
      throw new AppError('OBJECT_NOT_FOUND', `Object '${key}' not found`);
    }

    for (const sk of storageKeys) {
      this.storageBackend.delete(sk).catch((err) =>
        logger.warn('Failed to delete object from storage', { sk, err }),
      );
    }
    metrics.objects.deleted++;
  }

  private validateObjectKey(key: string): void {
    if (!key || key.length === 0) {
      throw new AppError('INVALID_OBJECT_KEY', 'Object key cannot be empty');
    }
    if (key.length > 1024) {
      throw new AppError('INVALID_OBJECT_KEY', 'Object key exceeds 1024 characters');
    }
    if (key.startsWith('/') || key.includes('//')) {
      throw new AppError('INVALID_OBJECT_KEY', 'Object key cannot start with / or contain //');
    }
  }
}
