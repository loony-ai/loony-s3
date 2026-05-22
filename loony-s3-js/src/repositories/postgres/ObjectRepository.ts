import { Pool } from 'pg';
import { getPool } from '../../db/postgres';
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
  size: string; // BIGINT comes back as string from pg
  mime_type: string;
  etag: string;
  storage_key: string;
  acl: string;
  version_id: string;
  is_latest: boolean;
  metadata: Record<string, string>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  expires_at: Date | null;
}

interface MultipartRow {
  upload_id: string;
  bucket_id: string;
  bucket_name: string;
  key: string;
  owner_id: string;
  metadata: Record<string, string>;
  parts: UploadPart[];
  created_at: Date;
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
    isLatest: row.is_latest,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}

function rowToMultipart(row: MultipartRow): MultipartUpload {
  return {
    uploadId: row.upload_id,
    bucketId: row.bucket_id,
    bucketName: row.bucket_name,
    key: row.key,
    ownerId: row.owner_id,
    metadata: row.metadata,
    parts: row.parts,
    createdAt: row.created_at,
  };
}

export class PostgresObjectRepository implements IObjectRepository {
  private get db(): Pool {
    return getPool();
  }

  // ─── Objects ──────────────────────────────────────────────────────────────

  async findById(id: string): Promise<StoredObject | undefined> {
    const { rows } = await this.db.query<ObjectRow>(
      'SELECT * FROM objects WHERE id = $1',
      [id],
    );
    return rows[0] ? rowToObject(rows[0]) : undefined;
  }

  async findLatest(bucketId: string, key: string): Promise<StoredObject | undefined> {
    const { rows } = await this.db.query<ObjectRow>(
      `SELECT * FROM objects
       WHERE bucket_id = $1 AND key = $2 AND is_latest = true AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [bucketId, key],
    );
    return rows[0] ? rowToObject(rows[0]) : undefined;
  }

  async findVersions(bucketId: string, key: string): Promise<StoredObject[]> {
    const { rows } = await this.db.query<ObjectRow>(
      'SELECT * FROM objects WHERE bucket_id = $1 AND key = $2 ORDER BY created_at DESC',
      [bucketId, key],
    );
    return rows.map(rowToObject);
  }

  async list(bucketId: string, query: ListObjectsQuery): Promise<ListObjectsResult> {
    const limit = Math.min(query.maxKeys ?? 1000, 1000);
    const prefix = query.prefix ?? '';
    const delimiter = query.delimiter ?? '';

    let rows: ObjectRow[];
    if (query.continuationToken) {
      const { rows: r } = await this.db.query<ObjectRow>(
        `SELECT * FROM objects
         WHERE bucket_id = $1 AND key LIKE $2 AND key > $3
           AND is_latest = true AND deleted_at IS NULL
         ORDER BY key ASC LIMIT $4`,
        [bucketId, prefix + '%', query.continuationToken, limit + 1],
      );
      rows = r;
    } else {
      const { rows: r } = await this.db.query<ObjectRow>(
        `SELECT * FROM objects
         WHERE bucket_id = $1 AND key LIKE $2
           AND is_latest = true AND deleted_at IS NULL
         ORDER BY key ASC LIMIT $3`,
        [bucketId, prefix + '%', limit + 1],
      );
      rows = r;
    }

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
    await this.db.query(
      'UPDATE objects SET is_latest = false WHERE bucket_id = $1 AND key = $2 AND is_latest = true',
      [obj.bucketId, obj.key],
    );

    await this.db.query(
      `INSERT INTO objects
         (id, bucket_id, bucket_name, key, size, mime_type, etag, storage_key,
          acl, version_id, is_latest, metadata, created_at, updated_at, deleted_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
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
        obj.isLatest,
        JSON.stringify(obj.metadata),
        obj.createdAt.toISOString(),
        obj.updatedAt.toISOString(),
        obj.deletedAt?.toISOString() ?? null,
        obj.expiresAt?.toISOString() ?? null,
      ],
    );
    return obj;
  }

  async hardDelete(bucketId: string, key: string, versionId?: string): Promise<string[]> {
    if (versionId) {
      const { rows } = await this.db.query<{ storage_key: string }>(
        'SELECT storage_key FROM objects WHERE bucket_id = $1 AND key = $2 AND version_id = $3',
        [bucketId, key, versionId],
      );
      await this.db.query(
        'DELETE FROM objects WHERE bucket_id = $1 AND key = $2 AND version_id = $3',
        [bucketId, key, versionId],
      );
      return rows.map((r) => r.storage_key);
    } else {
      const { rows } = await this.db.query<{ storage_key: string }>(
        'SELECT storage_key FROM objects WHERE bucket_id = $1 AND key = $2',
        [bucketId, key],
      );
      await this.db.query(
        'DELETE FROM objects WHERE bucket_id = $1 AND key = $2',
        [bucketId, key],
      );
      return rows.map((r) => r.storage_key);
    }
  }

  async findExpired(now: Date, limit: number): Promise<StoredObject[]> {
    const { rows } = await this.db.query<ObjectRow>(
      `SELECT * FROM objects
       WHERE expires_at IS NOT NULL AND expires_at < $1 AND deleted_at IS NULL
       ORDER BY expires_at ASC LIMIT $2`,
      [now.toISOString(), limit],
    );
    return rows.map(rowToObject);
  }

  async countInBucket(bucketId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM objects WHERE bucket_id = $1 AND deleted_at IS NULL',
      [bucketId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // ─── Multipart uploads ────────────────────────────────────────────────────

  async createMultipartUpload(upload: MultipartUpload): Promise<MultipartUpload> {
    await this.db.query(
      `INSERT INTO multipart_uploads
         (upload_id, bucket_id, bucket_name, key, owner_id, metadata, parts, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        upload.uploadId,
        upload.bucketId,
        upload.bucketName,
        upload.key,
        upload.ownerId,
        JSON.stringify(upload.metadata),
        JSON.stringify(upload.parts),
        upload.createdAt.toISOString(),
      ],
    );
    return upload;
  }

  async findMultipartUpload(uploadId: string): Promise<MultipartUpload | undefined> {
    const { rows } = await this.db.query<MultipartRow>(
      'SELECT * FROM multipart_uploads WHERE upload_id = $1',
      [uploadId],
    );
    return rows[0] ? rowToMultipart(rows[0]) : undefined;
  }

  async upsertPart(uploadId: string, part: UploadPart): Promise<void> {
    const { rows } = await this.db.query<{ parts: UploadPart[] }>(
      'SELECT parts FROM multipart_uploads WHERE upload_id = $1',
      [uploadId],
    );
    if (!rows[0]) throw new AppError('UPLOAD_NOT_FOUND', `Upload ${uploadId} not found`);

    const parts = rows[0].parts as UploadPart[];
    const idx = parts.findIndex((p) => p.partNumber === part.partNumber);
    if (idx >= 0) {
      parts[idx] = part;
    } else {
      parts.push(part);
      parts.sort((a, b) => a.partNumber - b.partNumber);
    }

    await this.db.query(
      'UPDATE multipart_uploads SET parts = $1 WHERE upload_id = $2',
      [JSON.stringify(parts), uploadId],
    );
  }

  async deleteMultipartUpload(uploadId: string): Promise<void> {
    await this.db.query('DELETE FROM multipart_uploads WHERE upload_id = $1', [uploadId]);
  }

  async findStaleMultipartUploads(olderThan: Date): Promise<MultipartUpload[]> {
    const { rows } = await this.db.query<MultipartRow>(
      'SELECT * FROM multipart_uploads WHERE created_at < $1',
      [olderThan.toISOString()],
    );
    return rows.map(rowToMultipart);
  }
}
