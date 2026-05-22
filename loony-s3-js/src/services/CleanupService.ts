import { IObjectRepository } from '../repositories/interfaces';
import { StorageBackend } from '../storage/StorageBackend';
import { config } from '../config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

export class CleanupService {
  constructor(
    private readonly objectRepo: IObjectRepository,
    private readonly storageBackend: StorageBackend,
  ) {}

  /**
   * Delete objects whose expiresAt has passed.
   * Processes up to config.cleanup.batchSize objects per run to avoid
   * holding long locks on the database.
   */
  async cleanExpiredObjects(): Promise<number> {
    const expired = await this.objectRepo.findExpired(new Date(), config.cleanup.batchSize);
    let count = 0;

    for (const obj of expired) {
      try {
        const storageKeys = await this.objectRepo.hardDelete(obj.bucketId, obj.key, obj.versionId);
        for (const sk of storageKeys) {
          await this.storageBackend.delete(sk).catch((err) =>
            logger.warn('Cleanup: failed to delete expired object from storage', { sk, err }),
          );
        }
        count++;
        metrics.objects.expired++;
        metrics.cleanup.expiredObjectsRemoved++;
      } catch (err) {
        logger.error('Cleanup: error deleting expired object', { key: obj.key, err });
      }
    }

    return count;
  }

  /**
   * Abort and remove multipart uploads that were started but never completed.
   * Parts (temporary storage files) are deleted along with the upload record.
   */
  async cleanStaleMultipartUploads(): Promise<number> {
    const cutoff = new Date(Date.now() - config.cleanup.staleUploadMaxAgeMs);
    const stale = await this.objectRepo.findStaleMultipartUploads(cutoff);
    let count = 0;

    for (const upload of stale) {
      try {
        const partKeys = upload.parts.map((p) => p.storageKey);
        await this.storageBackend.deleteParts(partKeys).catch((err) =>
          logger.warn('Cleanup: failed to delete stale parts', { uploadId: upload.uploadId, err }),
        );
        await this.objectRepo.deleteMultipartUpload(upload.uploadId);
        count++;
        metrics.cleanup.staleUploadsRemoved++;
      } catch (err) {
        logger.error('Cleanup: error aborting stale upload', { uploadId: upload.uploadId, err });
      }
    }

    return count;
  }
}
