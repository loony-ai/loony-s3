import {
  Bucket,
  StoredObject,
  MultipartUpload,
  UploadPart,
  ListObjectsQuery,
  ListObjectsResult,
} from '../types';

/**
 * All methods return Promises so both the node:sqlite implementation (which
 * wraps synchronous calls) and a future PostgreSQL implementation (inherently
 * async) satisfy the same contract without any changes to the service layer.
 */
export interface IBucketRepository {
  findByName(name: string): Promise<Bucket | undefined>;
  findById(id: string): Promise<Bucket | undefined>;
  listByOwner(ownerId: string): Promise<Bucket[]>;
  create(bucket: Bucket): Promise<Bucket>;
  update(
    id: string,
    updates: Partial<Pick<Bucket, 'acl' | 'versioning' | 'metadata'>>,
  ): Promise<Bucket>;
  delete(id: string): Promise<void>;
  existsByName(name: string): Promise<boolean>;
}

export interface IObjectRepository {
  findById(id: string): Promise<StoredObject | undefined>;
  /** Returns the latest non-deleted version. */
  findLatest(bucketId: string, key: string): Promise<StoredObject | undefined>;
  /** All versions of a key, newest first. */
  findVersions(bucketId: string, key: string): Promise<StoredObject[]>;
  list(bucketId: string, query: ListObjectsQuery): Promise<ListObjectsResult>;
  create(obj: StoredObject): Promise<StoredObject>;
  /** Hard-deletes and returns the storage keys that must be cleaned up. */
  hardDelete(bucketId: string, key: string, versionId?: string): Promise<string[]>;
  countInBucket(bucketId: string): Promise<number>;

  /** Objects whose expiresAt is in the past, newest first, up to limit rows. */
  findExpired(now: Date, limit: number): Promise<StoredObject[]>;

  createMultipartUpload(upload: MultipartUpload): Promise<MultipartUpload>;
  findMultipartUpload(uploadId: string): Promise<MultipartUpload | undefined>;
  upsertPart(uploadId: string, part: UploadPart): Promise<void>;
  deleteMultipartUpload(uploadId: string): Promise<void>;
  /** Multipart uploads whose createdAt is older than olderThan. */
  findStaleMultipartUploads(olderThan: Date): Promise<MultipartUpload[]>;
}
