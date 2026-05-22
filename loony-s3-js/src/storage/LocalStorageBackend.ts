import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable, pipeline as pipelineCb } from 'stream';
import { promisify } from 'util';
import { StorageBackend } from './StorageBackend';
import { StoredObjectInfo } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

const pipeline = promisify(pipelineCb);

/**
 * Local filesystem storage backend.
 *
 * Layout:
 *   $STORAGE_ROOT/
 *     {bucket-name}/
 *       {2-char-prefix}/          ← sharding to avoid huge directories
 *         {storageKey}            ← actual file
 *     __tmp/
 *       {uploadId}/
 *         {partNumber}            ← in-progress multipart parts
 */
export class LocalStorageBackend implements StorageBackend {
  private readonly root: string;

  constructor(root: string = config.storage.root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, '__tmp'), { recursive: true });
    logger.info('LocalStorageBackend initialized', { root });
  }

  private resolvePath(storageKey: string): string {
    // storageKey is expected to be "{bucket}/{prefix}/{uuid}" – treat it as
    // a relative path under root.
    return path.join(this.root, storageKey);
  }

  async write(
    storageKey: string,
    source: Readable,
    expectedSize?: number,
  ): Promise<StoredObjectInfo> {
    const dest = this.resolvePath(storageKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const hash = crypto.createHash('md5');
    let size = 0;

    // Write a tmp file first so we don't leave a partial object on failure.
    const tmpPath = dest + '.tmp.' + Date.now();
    const writeStream = fs.createWriteStream(tmpPath);

    try {
      await pipeline(
        source,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buf);
            size += buf.byteLength;
            yield buf;
          }
        },
        writeStream,
      );
    } catch (err) {
      // Clean up the tmp file if something went wrong.
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }

    if (expectedSize !== undefined && size !== expectedSize) {
      fs.rmSync(tmpPath, { force: true });
      throw new Error(
        `Size mismatch: expected ${expectedSize}, received ${size}`,
      );
    }

    fs.renameSync(tmpPath, dest);

    return { storageKey, size, etag: hash.digest('hex') };
  }

  async read(
    storageKey: string,
    range?: { start: number; end?: number },
  ): Promise<Readable> {
    const src = this.resolvePath(storageKey);
    if (!fs.existsSync(src)) {
      throw new Error(`Object not found in storage: ${storageKey}`);
    }
    return fs.createReadStream(src, range);
  }

  async stat(storageKey: string): Promise<{ size: number }> {
    const src = this.resolvePath(storageKey);
    const stat = fs.statSync(src);
    return { size: stat.size };
  }

  async delete(storageKey: string): Promise<void> {
    const filePath = this.resolvePath(storageKey);
    try {
      fs.rmSync(filePath, { force: true });
      // Attempt to remove empty parent directories (best-effort).
      this.pruneEmptyDirs(path.dirname(filePath));
    } catch (err) {
      logger.warn('Failed to delete storage object', { storageKey, err });
    }
  }

  async assembleMultipart(
    partKeys: string[],
    destinationKey: string,
  ): Promise<StoredObjectInfo> {
    const dest = this.resolvePath(destinationKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const hash = crypto.createHash('md5');
    let totalSize = 0;
    const writeStream = fs.createWriteStream(dest);

    try {
      for (const partKey of partKeys) {
        const partPath = this.resolvePath(partKey);
        const partStream = fs.createReadStream(partPath);

        await new Promise<void>((resolve, reject) => {
          partStream.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buf);
            totalSize += buf.byteLength;
          });
          partStream.pipe(writeStream, { end: false });
          partStream.on('end', resolve);
          partStream.on('error', reject);
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        writeStream.end((err: Error | null) => (err ? reject(err) : resolve())),
      );
    }

    // Remove parts after assembly.
    await this.deleteParts(partKeys);

    return { storageKey: destinationKey, size: totalSize, etag: hash.digest('hex') };
  }

  async deleteParts(partKeys: string[]): Promise<void> {
    for (const key of partKeys) {
      const filePath = this.resolvePath(key);
      fs.rmSync(filePath, { force: true });
    }
  }

  private pruneEmptyDirs(dir: string): void {
    if (!dir.startsWith(this.root) || dir === this.root) return;
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        this.pruneEmptyDirs(path.dirname(dir));
      }
    } catch {
      // ignore – directory may already be removed or may not be empty
    }
  }
}
