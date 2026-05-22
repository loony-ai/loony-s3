// ─── Domain Types ────────────────────────────────────────────────────────────

export type BucketACL = 'private' | 'public-read' | 'public-read-write';
export type ObjectACL = 'private' | 'public-read';
export type PresignedOperation = 'GET' | 'PUT' | 'DELETE';

export interface Bucket {
  id: string;
  name: string;
  ownerId: string;
  acl: BucketACL;
  region: string;
  versioning: boolean;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, string>;
}

export interface StoredObject {
  id: string;
  bucketId: string;
  bucketName: string;
  key: string;
  size: number;
  mimeType: string;
  etag: string;        // MD5 hex of the object content
  storageKey: string;  // internal filesystem path segment
  acl: ObjectACL;
  versionId: string;
  isLatest: boolean;
  metadata: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  expiresAt?: Date;
}

export interface MultipartUpload {
  uploadId: string;
  bucketId: string;
  bucketName: string;
  key: string;
  ownerId: string;
  metadata: Record<string, string>;
  parts: UploadPart[];
  createdAt: Date;
}

export interface UploadPart {
  partNumber: number;  // 1–10000
  etag: string;
  size: number;
  storageKey: string;
}

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
  operation: PresignedOperation;
}

// ─── API Request / Response shapes ───────────────────────────────────────────

export interface CreateBucketRequest {
  name: string;
  acl?: BucketACL;
  region?: string;
  versioning?: boolean;
  metadata?: Record<string, string>;
}

export interface UpdateBucketRequest {
  acl?: BucketACL;
  versioning?: boolean;
  metadata?: Record<string, string>;
}

export interface ListObjectsQuery {
  prefix?: string;
  delimiter?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListObjectsResult {
  objects: StoredObject[];
  commonPrefixes: string[];       // "directories" when delimiter is used
  isTruncated: boolean;
  nextContinuationToken?: string;
  keyCount: number;
}

export interface CompleteMultipartUploadRequest {
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface GeneratePresignedUrlRequest {
  bucketName: string;
  key: string;
  operation: PresignedOperation;
  expiresInSeconds: number;
  metadata?: Record<string, string>;
}

// ─── Storage Backend ──────────────────────────────────────────────────────────

export interface WriteObjectOptions {
  mimeType: string;
  metadata?: Record<string, string>;
}

export interface StoredObjectInfo {
  storageKey: string;
  size: number;
  etag: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthenticatedUser {
  id: string;
  name: string;
}

export interface JwtPayload {
  sub: string;    // userId
  name: string;
  iat: number;
  exp: number;
}

// ─── Express augmentation ────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      // set by presigned-url middleware when a presigned request is validated
      presignedContext?: {
        bucketName: string;
        key: string;
        operation: PresignedOperation;
      };
    }
  }
}
