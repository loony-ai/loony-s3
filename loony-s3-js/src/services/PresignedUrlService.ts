import crypto from 'crypto';
import { PresignedUrl, PresignedOperation, GeneratePresignedUrlRequest } from '../types';
import { IBucketRepository } from '../repositories/interfaces';
import { AppError } from '../utils/AppError';
import { config } from '../config';

/**
 * Pre-signed URL structure:
 *
 *   GET /presigned/{bucket}/{key}
 *     ?X-Expires={unix-timestamp}
 *     &X-Operation={GET|PUT|DELETE}
 *     &X-Signature={hmac-sha256}
 *
 * Signature = HMAC-SHA256(secret, "{operation}\n{bucket}\n{key}\n{expires}")
 *
 * This is intentionally simple.  A production system would use a canonical
 * request approach similar to AWS Signature V4.
 */
export class PresignedUrlService {
  constructor(private readonly bucketRepo: IBucketRepository) {}

  async generate(req: GeneratePresignedUrlRequest, requesterId: string): Promise<PresignedUrl> {
    if (req.expiresInSeconds > config.presigned.maxExpirySeconds) {
      throw new AppError(
        'PRESIGNED_URL_INVALID',
        `Expiry exceeds maximum of ${config.presigned.maxExpirySeconds} seconds`,
      );
    }

    const bucket = await this.bucketRepo.findByName(req.bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${req.bucketName}' not found`);
    if (bucket.ownerId !== requesterId) {
      throw new AppError('ACCESS_DENIED', 'Only bucket owners can generate pre-signed URLs');
    }

    const expiresAt = new Date(Date.now() + req.expiresInSeconds * 1000);
    const expiresTs = Math.floor(expiresAt.getTime() / 1000);

    const signature = this.sign(req.operation, req.bucketName, req.key, expiresTs);

    const url = new URL(
      `/presigned/${encodeURIComponent(req.bucketName)}/${encodeURIComponent(req.key)}`,
      config.baseUrl,
    );
    url.searchParams.set('X-Expires', String(expiresTs));
    url.searchParams.set('X-Operation', req.operation);
    url.searchParams.set('X-Signature', signature);

    return { url: url.toString(), expiresAt, operation: req.operation };
  }

  /**
   * Validate an incoming presigned request.
   * Throws AppError if invalid or expired.
   */
  validate(
    bucketName: string,
    key: string,
    operation: PresignedOperation,
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

    const expected = this.sign(operation, bucketName, key, expiresTs);

    // Constant-time comparison to prevent timing attacks.
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(signatureParam, 'hex');

    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new AppError('PRESIGNED_URL_INVALID', 'Invalid signature');
    }
  }

  private sign(
    operation: PresignedOperation,
    bucket: string,
    key: string,
    expiresTs: number,
  ): string {
    const message = `${operation}\n${bucket}\n${key}\n${expiresTs}`;
    return crypto
      .createHmac('sha256', config.presigned.secret)
      .update(message)
      .digest('hex');
  }
}
