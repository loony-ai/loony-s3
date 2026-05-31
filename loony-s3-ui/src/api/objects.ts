import { request, uploadFile } from './client';

export interface S3Object {
  key: string;
  size: number;
  mime_type: string;
  etag: string;
  version_id: string;
  is_latest: boolean;
  acl: string;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

export interface ListResult {
  objects: S3Object[];
  common_prefixes: string[];
  is_truncated: boolean;
  next_continuation_token?: string;
  key_count: number;
}

export interface PresignedResult {
  url: string;
  expires_at: number;
}

const MULTIPART_THRESHOLD = 10 * 1024 * 1024; // 10 MB
const PART_SIZE = 6 * 1024 * 1024;            // 6 MB

export function listObjects(
  bucket: string,
  prefix = '',
  delimiter = '/',
  continuationToken?: string,
): Promise<ListResult> {
  const params = new URLSearchParams({ list: 'true' });
  if (prefix) params.set('prefix', prefix);
  if (delimiter) params.set('delimiter', delimiter);
  if (continuationToken) params.set('continuationToken', continuationToken);
  return request(`/${bucket}/list?${params}`);
}

export function deleteObject(bucket: string, key: string): Promise<void> {
  return request(`/${bucket}/${key}`, { method: 'DELETE' });
}

export function getPresignedUrl(
  bucket: string,
  key: string,
  expiresInSeconds = 3600,
): Promise<PresignedResult> {
  const params = new URLSearchParams({
    presign: 'true',
    operation: 'get',
    expiresInSeconds: String(expiresInSeconds),
  });
  return request(`/${bucket}/${encodeURIComponent(key)}?${params}`);
}

export async function uploadObject(
  bucket: string,
  key: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<S3Object> {
  if (file.size < MULTIPART_THRESHOLD) {
    const res = await uploadFile(`/${bucket}/${encodeURIComponent(key)}`, file, onProgress) as { object: S3Object };
    return res.object;
  }
  return uploadMultipart(bucket, key, file, onProgress);
}

async function uploadMultipart(
  bucket: string,
  key: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<S3Object> {
  const encodedKey = encodeURIComponent(key);

  // 1. Initiate
  const { uploadId } = await request<{ uploadId: string }>(
    `/${bucket}/${encodedKey}?uploads`,
    { method: 'POST', body: {} },
  );

  const totalParts = Math.ceil(file.size / PART_SIZE);
  const partNumbers: number[] = [];
  let uploaded = 0;

  // 2. Upload parts
  for (let i = 0; i < totalParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, file.size);
    const chunk = file.slice(start, end);
    const partNumber = i + 1;

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const token = ((): string | null => {
        try {
          const raw = localStorage.getItem('loony-s3-auth');
          if (!raw) return null;
          return (JSON.parse(raw) as { state?: { token?: string } }).state?.token ?? null;
        } catch { return null; }
      })();

      const apiUrl = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';
      xhr.open('PUT', `${apiUrl}/${bucket}/${encodedKey}?partNumber=${partNumber}&uploadId=${uploadId}`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          const partDone = (uploaded + e.loaded) / file.size;
          onProgress(Math.round(partDone * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          uploaded += (end - start);
          resolve();
        } else {
          reject(new Error(`Part ${partNumber} failed: ${xhr.statusText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(chunk);
    });

    partNumbers.push(partNumber);
  }

  // 3. Complete
  const res = await request<{ object: S3Object }>(
    `/${bucket}/${encodedKey}?uploadId=${uploadId}`,
    { method: 'POST', body: { parts: partNumbers } },
  );
  onProgress?.(100);
  return res.object;
}
