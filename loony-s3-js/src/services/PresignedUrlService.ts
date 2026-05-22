import crypto from 'crypto';
import { PresignedOperation } from '../types';
import { IBucketRepository } from '../repositories/interfaces';
import { AppError } from '../utils/AppError';
import { config } from '../config';

/**
 * Pre-signed URL structure:
 *
 *   /{bucket}/{key}?operation={GET|PUT|DELETE}&expires={unix-ts}&signature={hmac-sha256}
 *
 * Signature = HMAC-SHA256(secret, "{operation}:{bucket}:{key}:{expires}")
 */
export class PresignedUrlService {
  constructor(private readonly bucketRepo: IBucketRepository) {}

  async generate(
    bucketName: string,
    key: string,
    operation: PresignedOperation,
    expiresInSeconds: number,
    requesterId: string,
  ): Promise<{ url: string; expiresAt: number }> {
    if (expiresInSeconds > config.presigned.maxExpirySeconds) {
      throw new AppError(
        'PRESIGNED_URL_INVALID',
        `Expiry exceeds maximum of ${config.presigned.maxExpirySeconds} seconds`,
      );
    }

    const bucket = await this.bucketRepo.findByName(bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${bucketName}' not found`);
    if (bucket.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', 'Only bucket owners can generate pre-signed URLs');
    }

    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = this.sign(operation, bucketName, key, expiresAt);

    const url = new URL(`/${encodeURIComponent(bucketName)}/${encodeURIComponent(key)}`, config.baseUrl);
    url.searchParams.set('operation', operation);
    url.searchParams.set('expires', String(expiresAt));
    url.searchParams.set('signature', signature);

    return { url: url.toString(), expiresAt };
  }

  validate(
    bucketName: string,
    key: string,
    operation: string,
    expiresParam: string,
    signatureParam: string,
  ): void {
    const expiresTs = parseInt(expiresParam, 10);
    if (isNaN(expiresTs)) {
      throw new AppError('PRESIGNED_URL_INVALID', 'Invalid expiry parameter');
    }

    const nowTs = Math.floor(Date.now() / 1000);
    if (nowTs > expiresTs) {
      throw new AppError('PRESIGNED_URL_EXPIRED', 'Pre-signed URL has expired');
    }

    const expected = this.sign(operation as PresignedOperation, bucketName, key, expiresTs);

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(signatureParam, 'hex');

    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new AppError('PRESIGNED_URL_INVALID', 'Invalid signature');
    }
  }

  private sign(operation: PresignedOperation, bucket: string, key: string, expiresTs: number): string {
    const message = `${operation}:${bucket}:${key}:${expiresTs}`;
    return crypto
      .createHmac('sha256', config.presigned.secret)
      .update(message)
      .digest('hex');
  }
}
