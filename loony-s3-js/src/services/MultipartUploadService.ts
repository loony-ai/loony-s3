import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import mime from 'mime-types';
import {
  MultipartUpload,
  UploadPart,
  StoredObject,
  ObjectACL,
  CompleteMultipartUploadRequest,
} from '../types';
import { IBucketRepository, IObjectRepository } from '../repositories/interfaces';
import { StorageBackend } from '../storage/StorageBackend';
import { BucketService } from './BucketService';
import { AppError } from '../utils/AppError';
import { config } from '../config';
import { logger } from '../utils/logger';

export class MultipartUploadService {
  constructor(
    private readonly bucketRepo: IBucketRepository,
    private readonly objectRepo: IObjectRepository,
    private readonly storageBackend: StorageBackend,
    private readonly bucketService: BucketService,
  ) {}

  /**
   * Phase 1 — Initiate.
   * Returns the uploadId clients use in subsequent part uploads.
   */
  async initiateUpload(
    bucketName: string,
    key: string,
    requesterId: string,
    metadata?: Record<string, string>,
  ): Promise<MultipartUpload> {
    const bucket = await this.bucketRepo.findByName(bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${bucketName}' not found`);
    this.bucketService.assertWriteAccess(bucket, requesterId);

    const upload: MultipartUpload = {
      uploadId: uuidv4().replace(/-/g, ''),
      bucketId: bucket.id,
      bucketName: bucket.name,
      key,
      ownerId: requesterId,
      metadata: metadata ?? {},
      parts: [],
      createdAt: new Date(),
    };

    return this.objectRepo.createMultipartUpload(upload);
  }

  /**
   * Phase 2 — Upload a part.
   * Parts are stored temporarily; they are assembled in `completeUpload`.
   * Part numbers are 1-based (1–10000).
   */
  async uploadPart(
    uploadId: string,
    partNumber: number,
    stream: Readable,
    requesterId: string,
    contentLength?: number,
  ): Promise<UploadPart> {
    this.validatePartNumber(partNumber);

    const upload = await this.objectRepo.findMultipartUpload(uploadId);
    if (!upload) throw new AppError('UPLOAD_NOT_FOUND', `Upload '${uploadId}' not found`);
    if (upload.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', 'Access denied to this upload');
    }

    // storageKey for parts: __tmp/{uploadId}/{partNumber}
    const partKey = path.posix.join('__tmp', uploadId, String(partNumber));

    const info = await this.storageBackend.write(partKey, stream, contentLength);

    const part: UploadPart = {
      partNumber,
      etag: info.etag,
      size: info.size,
      storageKey: partKey,
    };

    await this.objectRepo.upsertPart(uploadId, part);
    logger.debug('Part uploaded', { uploadId, partNumber, size: info.size, etag: info.etag });

    return part;
  }

  /**
   * Phase 3 — Complete.
   * Assembles parts in order, creates the final object, removes part files.
   */
  async completeUpload(
    uploadId: string,
    req: CompleteMultipartUploadRequest,
    requesterId: string,
    acl?: ObjectACL,
  ): Promise<StoredObject> {
    const upload = await this.objectRepo.findMultipartUpload(uploadId);
    if (!upload) throw new AppError('UPLOAD_NOT_FOUND', `Upload '${uploadId}' not found`);
    if (upload.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', 'Access denied');
    }

    const bucket = await this.bucketRepo.findById(upload.bucketId);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', 'Bucket no longer exists');

    // Validate requested parts against what we have stored.
    const storedMap = new Map(upload.parts.map((p) => [p.partNumber, p]));
    const orderedParts: UploadPart[] = [];

    for (const reqPart of req.parts) {
      const stored = storedMap.get(reqPart.partNumber);
      if (!stored) {
        throw new AppError(
          'INVALID_PART_NUMBER',
          `Part ${reqPart.partNumber} was not uploaded`,
        );
      }
      if (stored.etag !== reqPart.etag) {
        throw new AppError(
          'INVALID_PART_NUMBER',
          `ETag mismatch for part ${reqPart.partNumber}`,
        );
      }
      orderedParts.push(stored);
    }

    orderedParts.sort((a, b) => a.partNumber - b.partNumber);

    // All parts except the last must meet the configured minimum size.
    if (config.upload.minPartSizeBytes > 0) {
      for (let i = 0; i < orderedParts.length - 1; i++) {
        if (orderedParts[i]!.size < config.upload.minPartSizeBytes) {
          throw new AppError(
            'INVALID_PART_SIZE',
            `Part ${orderedParts[i]!.partNumber} size ${orderedParts[i]!.size} is below the ${config.upload.minPartSizeBytes}-byte minimum`,
          );
        }
      }
    }

    const versionId = uuidv4().replace(/-/g, '');
    const shard = versionId.slice(0, 2);
    const destinationKey = path.posix.join(upload.bucketName, shard, versionId);

    const info = await this.storageBackend.assembleMultipart(
      orderedParts.map((p) => p.storageKey),
      destinationKey,
    );

    const now = new Date();
    const obj: StoredObject = {
      id: uuidv4(),
      bucketId: bucket.id,
      bucketName: bucket.name,
      key: upload.key,
      size: info.size,
      mimeType: mime.lookup(upload.key) || 'application/octet-stream',
      etag: info.etag,
      storageKey: info.storageKey,
      acl: acl ?? 'private',
      versionId,
      isLatest: true,
      metadata: upload.metadata,
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.objectRepo.create(obj);
    await this.objectRepo.deleteMultipartUpload(uploadId);

    logger.info('Multipart upload completed', {
      uploadId,
      key: upload.key,
      size: info.size,
      parts: orderedParts.length,
    });

    return created;
  }

  /**
   * Abort — remove all parts and the upload record.
   */
  async abortUpload(uploadId: string, requesterId: string): Promise<void> {
    const upload = await this.objectRepo.findMultipartUpload(uploadId);
    if (!upload) throw new AppError('UPLOAD_NOT_FOUND', `Upload '${uploadId}' not found`);
    if (upload.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', 'Access denied');
    }

    const partKeys = upload.parts.map((p) => p.storageKey);
    await this.storageBackend.deleteParts(partKeys);
    await this.objectRepo.deleteMultipartUpload(uploadId);

    logger.info('Multipart upload aborted', { uploadId });
  }

  async listParts(uploadId: string, requesterId: string): Promise<UploadPart[]> {
    const upload = await this.objectRepo.findMultipartUpload(uploadId);
    if (!upload) throw new AppError('UPLOAD_NOT_FOUND', `Upload '${uploadId}' not found`);
    if (upload.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', 'Access denied');
    }
    return upload.parts;
  }

  private validatePartNumber(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > config.upload.maxParts) {
      throw new AppError(
        'INVALID_PART_NUMBER',
        `Part number must be an integer between 1 and ${config.upload.maxParts}`,
      );
    }
  }
}
