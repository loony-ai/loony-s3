import { DatabaseSync } from 'node:sqlite';
import { getDb } from '../../db/database';
import { Bucket, BucketACL } from '../../types';
import { AppError } from '../../utils/AppError';
import { IBucketRepository } from '../interfaces';

interface BucketRow {
  id: string;
  name: string;
  owner_id: string;
  acl: string;
  region: string;
  versioning: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function rowToBucket(row: BucketRow): Bucket {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    acl: row.acl as BucketACL,
    region: row.region,
    versioning: row.versioning === 1,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * SQLite implementation of IBucketRepository.
 * node:sqlite is synchronous; all methods wrap their return values in
 * Promise.resolve() so this class satisfies the async interface that the
 * PostgreSQL implementation will also implement.
 */
export class SqliteBucketRepository implements IBucketRepository {
  private get db(): DatabaseSync {
    return getDb();
  }

  async findByName(name: string): Promise<Bucket | undefined> {
    const row = this.db.prepare('SELECT * FROM buckets WHERE name = ?').get(name) as BucketRow | undefined;
    return row ? rowToBucket(row) : undefined;
  }

  async findById(id: string): Promise<Bucket | undefined> {
    const row = this.db.prepare('SELECT * FROM buckets WHERE id = ?').get(id) as BucketRow | undefined;
    return row ? rowToBucket(row) : undefined;
  }

  async listByOwner(ownerId: string): Promise<Bucket[]> {
    return (
      this.db.prepare(
        'SELECT * FROM buckets WHERE owner_id = ? ORDER BY created_at ASC',
      ).all(ownerId) as unknown as BucketRow[]
    ).map(rowToBucket);
  }

  async create(bucket: Bucket): Promise<Bucket> {
    this.db.prepare(
      `INSERT INTO buckets
         (id, name, owner_id, acl, region, versioning, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bucket.id,
      bucket.name,
      bucket.ownerId,
      bucket.acl,
      bucket.region,
      bucket.versioning ? 1 : 0,
      JSON.stringify(bucket.metadata),
      bucket.createdAt.toISOString(),
      bucket.updatedAt.toISOString(),
    );
    return bucket;
  }

  async update(
    id: string,
    updates: Partial<Pick<Bucket, 'acl' | 'versioning' | 'metadata'>>,
  ): Promise<Bucket> {
    const existing = await this.findById(id);
    if (!existing) throw new AppError('BUCKET_NOT_FOUND', `Bucket ${id} not found`);

    this.db.prepare(
      `UPDATE buckets
       SET acl = ?, versioning = ?, metadata = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      updates.acl ?? existing.acl,
      (updates.versioning ?? existing.versioning) ? 1 : 0,
      JSON.stringify(updates.metadata ?? existing.metadata),
      new Date().toISOString(),
      id,
    );

    return (await this.findById(id))!;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM buckets WHERE id = ?').run(id);
  }

  async existsByName(name: string): Promise<boolean> {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM buckets WHERE name = ?',
    ).get(name) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  }
}
