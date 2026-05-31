import { request } from './client';

export interface Bucket {
  id: string;
  name: string;
  owner_id: string;
  acl: 'private' | 'public-read' | 'public-read-write';
  region: string;
  versioning: boolean;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export function listBuckets(): Promise<{ buckets: Bucket[]; count: number }> {
  return request('/buckets');
}

export function createBucket(
  name: string,
  acl: Bucket['acl'] = 'private',
): Promise<{ bucket: Bucket }> {
  return request('/buckets', { method: 'POST', body: { name, acl } });
}

export function deleteBucket(name: string, force = false): Promise<void> {
  return request(`/buckets/${name}${force ? '?force=true' : ''}`, { method: 'DELETE' });
}
