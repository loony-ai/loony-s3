import { DatabaseSync } from 'node:sqlite';
import { getDb } from '../../db/database';
import {
  StoredObject,
  ObjectACL,
  MultipartUpload,
  UploadPart,
  ListObjectsQuery,
  ListObjectsResult,
} from '../../types';
import { AppError } from '../../utils/AppError';
import { IObjectRepository } from '../interfaces';

interface ObjectRow {
  id: string;
  bucket_id: string;
  bucket_name: string;
  key: string;
  size: number;
  mime_type: string;
  etag: string;
  storage_key: string;
  acl: string;
  version_id: string;
  is_latest: number;
  metadata: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  expires_at: string | null;
}

interface MultipartRow {
  upload_id: string;
  bucket_id: string;
  bucket_name: string;
  key: string;
  owner_id: string;
  metadata: string;
  parts: string;
  created_at: string;
}

function rowToObject(row: ObjectRow): StoredObject {
  return {
    id: row.id,
    bucketId: row.bucket_id,
    bucketName: row.bucket_name,
    key: row.key,
    size: Number(row.size),
    mimeType: row.mime_type,
    etag: row.etag,
    storageKey: row.storage_key,
    acl: row.acl as ObjectACL,
    versionId: row.version_id,
    isLatest: row.is_latest === 1,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
  };
}

function rowToMultipart(row: MultipartRow): MultipartUpload {
  return {
    uploadId: row.upload_id,
    bucketId: row.bucket_id,
    bucketName: row.bucket_name,
    key: row.key,
    ownerId: row.owner_id,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    parts: JSON.parse(row.parts) as UploadPart[],
    createdAt: new Date(row.created_at),
  };
}

/**
 * SQLite implementation of IObjectRepository.
 * All methods return Promises (wrapping synchronous node:sqlite calls) so
 * this class is a drop-in replacement for a future async PostgreSQL version.
 */
export class SqliteObjectRepository implements IObjectRepository {
  private get db(): DatabaseSync {
    return getDb();
  }

  // ─── Objects ──────────────────────────────────────────────────────────────

  async findById(id: string): Promise<StoredObject | undefined> {
    const row = this.db.prepare('SELECT * FROM objects WHERE id = ?').get(id) as ObjectRow | undefined;
    return row ? rowToObject(row) : undefined;
  }

  async findLatest(bucketId: string, key: string): Promise<StoredObject | undefined> {
    const row = this.db.prepare(
      `SELECT * FROM objects
       WHERE bucket_id = ? AND key = ? AND is_latest = 1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    ).get(bucketId, key) as ObjectRow | undefined;
    return row ? rowToObject(row) : undefined;
  }

  async findVersions(bucketId: string, key: string): Promise<StoredObject[]> {
    return (
      this.db.prepare(
        'SELECT * FROM objects WHERE bucket_id = ? AND key = ? ORDER BY created_at DESC',
      ).all(bucketId, key) as unknown as ObjectRow[]
    ).map(rowToObject);
  }

  async list(bucketId: string, query: ListObjectsQuery): Promise<ListObjectsResult> {
    const limit = Math.min(query.maxKeys ?? 1000, 1000);
    const prefix = query.prefix ?? '';
    const delimiter = query.delimiter ?? '';

    const rows = (
      query.continuationToken
        ? this.db.prepare(
            `SELECT * FROM objects
             WHERE bucket_id = ? AND key LIKE ? AND key > ?
               AND is_latest = 1 AND deleted_at IS NULL
             ORDER BY key ASC LIMIT ?`,
          ).all(bucketId, prefix + '%', query.continuationToken, limit + 1)
        : this.db.prepare(
            `SELECT * FROM objects
             WHERE bucket_id = ? AND key LIKE ?
               AND is_latest = 1 AND deleted_at IS NULL
             ORDER BY key ASC LIMIT ?`,
          ).all(bucketId, prefix + '%', limit + 1)
    ) as unknown as ObjectRow[];

    const isTruncated = rows.length > limit;
    const pageRows = isTruncated ? rows.slice(0, limit) : rows;

    const objects: StoredObject[] = [];
    const commonPrefixSet = new Set<string>();

    for (const row of pageRows) {
      const obj = rowToObject(row);
      if (delimiter) {
        const afterPrefix = obj.key.slice(prefix.length);
        const delimIdx = afterPrefix.indexOf(delimiter);
        if (delimIdx !== -1) {
          commonPrefixSet.add(prefix + afterPrefix.slice(0, delimIdx + delimiter.length));
          continue;
        }
      }
      objects.push(obj);
    }

    return {
      objects,
      commonPrefixes: Array.from(commonPrefixSet).sort(),
      isTruncated,
      nextContinuationToken: isTruncated ? pageRows[pageRows.length - 1]!.key : undefined,
      keyCount: objects.length + commonPrefixSet.size,
    };
  }

  async create(obj: StoredObject): Promise<StoredObject> {
    this.db.prepare(
      'UPDATE objects SET is_latest = 0 WHERE bucket_id = ? AND key = ? AND is_latest = 1',
    ).run(obj.bucketId, obj.key);

    this.db.prepare(
      `INSERT INTO objects
         (id, bucket_id, bucket_name, key, size, mime_type, etag, storage_key,
          acl, version_id, is_latest, metadata, created_at, updated_at, deleted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      obj.id,
      obj.bucketId,
      obj.bucketName,
      obj.key,
      obj.size,
      obj.mimeType,
      obj.etag,
      obj.storageKey,
      obj.acl,
      obj.versionId,
      obj.isLatest ? 1 : 0,
      JSON.stringify(obj.metadata),
      obj.createdAt.toISOString(),
      obj.updatedAt.toISOString(),
      obj.deletedAt?.toISOString() ?? null,
      obj.expiresAt?.toISOString() ?? null,
    );
    return obj;
  }

  async hardDelete(bucketId: string, key: string, versionId?: string): Promise<string[]> {
    let rows: ObjectRow[];
    if (versionId) {
      rows = this.db.prepare(
        'SELECT * FROM objects WHERE bucket_id = ? AND key = ? AND version_id = ?',
      ).all(bucketId, key, versionId) as unknown as ObjectRow[];
      this.db.prepare(
        'DELETE FROM objects WHERE bucket_id = ? AND key = ? AND version_id = ?',
      ).run(bucketId, key, versionId);
    } else {
      rows = this.db.prepare(
        'SELECT * FROM objects WHERE bucket_id = ? AND key = ?',
      ).all(bucketId, key) as unknown as ObjectRow[];
      this.db.prepare('DELETE FROM objects WHERE bucket_id = ? AND key = ?').run(bucketId, key);
    }
    return rows.map((r) => r.storage_key);
  }

  async findExpired(now: Date, limit: number): Promise<StoredObject[]> {
    return (
      this.db.prepare(
        `SELECT * FROM objects
         WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL
         ORDER BY expires_at ASC LIMIT ?`,
      ).all(now.toISOString(), limit) as unknown as ObjectRow[]
    ).map(rowToObject);
  }

  async countInBucket(bucketId: string): Promise<number> {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM objects WHERE bucket_id = ? AND deleted_at IS NULL',
    ).get(bucketId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  // ─── Multipart uploads ────────────────────────────────────────────────────

  async createMultipartUpload(upload: MultipartUpload): Promise<MultipartUpload> {
    this.db.prepare(
      `INSERT INTO multipart_uploads
         (upload_id, bucket_id, bucket_name, key, owner_id, metadata, parts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      upload.uploadId,
      upload.bucketId,
      upload.bucketName,
      upload.key,
      upload.ownerId,
      JSON.stringify(upload.metadata),
      JSON.stringify(upload.parts),
      upload.createdAt.toISOString(),
    );
    return upload;
  }

  async findMultipartUpload(uploadId: string): Promise<MultipartUpload | undefined> {
    const row = this.db.prepare(
      'SELECT * FROM multipart_uploads WHERE upload_id = ?',
    ).get(uploadId) as MultipartRow | undefined;
    return row ? rowToMultipart(row) : undefined;
  }

  async upsertPart(uploadId: string, part: UploadPart): Promise<void> {
    const row = this.db.prepare(
      'SELECT parts FROM multipart_uploads WHERE upload_id = ?',
    ).get(uploadId) as Pick<MultipartRow, 'parts'> | undefined;

    if (!row) throw new AppError('UPLOAD_NOT_FOUND', `Upload ${uploadId} not found`);

    const parts = JSON.parse(row.parts) as UploadPart[];
    const idx = parts.findIndex((p) => p.partNumber === part.partNumber);
    if (idx >= 0) {
      parts[idx] = part;
    } else {
      parts.push(part);
      parts.sort((a, b) => a.partNumber - b.partNumber);
    }

    this.db.prepare(
      'UPDATE multipart_uploads SET parts = ? WHERE upload_id = ?',
    ).run(JSON.stringify(parts), uploadId);
  }

  async deleteMultipartUpload(uploadId: string): Promise<void> {
    this.db.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?').run(uploadId);
  }

  async findStaleMultipartUploads(olderThan: Date): Promise<MultipartUpload[]> {
    return (
      this.db.prepare(
        'SELECT * FROM multipart_uploads WHERE created_at < ?',
      ).all(olderThan.toISOString()) as unknown as MultipartRow[]
    ).map(rowToMultipart);
  }
}
