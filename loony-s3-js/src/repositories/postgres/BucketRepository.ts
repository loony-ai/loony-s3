import { Pool } from 'pg';
import { getPool } from '../../db/postgres';
import { Bucket, BucketACL } from '../../types';
import { AppError } from '../../utils/AppError';
import { IBucketRepository } from '../interfaces';

interface BucketRow {
  id: string;
  name: string;
  owner_id: string;
  acl: string;
  region: string;
  versioning: boolean;
  metadata: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

function rowToBucket(row: BucketRow): Bucket {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    acl: row.acl as BucketACL,
    region: row.region,
    versioning: row.versioning,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresBucketRepository implements IBucketRepository {
  private get db(): Pool {
    return getPool();
  }

  async findByName(name: string): Promise<Bucket | undefined> {
    const { rows } = await this.db.query<BucketRow>(
      'SELECT * FROM buckets WHERE name = $1',
      [name],
    );
    return rows[0] ? rowToBucket(rows[0]) : undefined;
  }

  async findById(id: string): Promise<Bucket | undefined> {
    const { rows } = await this.db.query<BucketRow>(
      'SELECT * FROM buckets WHERE id = $1',
      [id],
    );
    return rows[0] ? rowToBucket(rows[0]) : undefined;
  }

  async listByOwner(ownerId: string): Promise<Bucket[]> {
    const { rows } = await this.db.query<BucketRow>(
      'SELECT * FROM buckets WHERE owner_id = $1 ORDER BY created_at ASC',
      [ownerId],
    );
    return rows.map(rowToBucket);
  }

  async create(bucket: Bucket): Promise<Bucket> {
    await this.db.query(
      `INSERT INTO buckets
         (id, name, owner_id, acl, region, versioning, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        bucket.id,
        bucket.name,
        bucket.ownerId,
        bucket.acl,
        bucket.region,
        bucket.versioning,
        JSON.stringify(bucket.metadata),
        bucket.createdAt.toISOString(),
        bucket.updatedAt.toISOString(),
      ],
    );
    return bucket;
  }

  async update(
    id: string,
    updates: Partial<Pick<Bucket, 'acl' | 'versioning' | 'metadata'>>,
  ): Promise<Bucket> {
    const existing = await this.findById(id);
    if (!existing) throw new AppError('BUCKET_NOT_FOUND', `Bucket ${id} not found`);

    await this.db.query(
      `UPDATE buckets
       SET acl = $1, versioning = $2, metadata = $3, updated_at = $4
       WHERE id = $5`,
      [
        updates.acl ?? existing.acl,
        updates.versioning ?? existing.versioning,
        JSON.stringify(updates.metadata ?? existing.metadata),
        new Date().toISOString(),
        id,
      ],
    );

    return (await this.findById(id))!;
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM buckets WHERE id = $1', [id]);
  }

  async existsByName(name: string): Promise<boolean> {
    const { rows } = await this.db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM buckets WHERE name = $1',
      [name],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }
}
