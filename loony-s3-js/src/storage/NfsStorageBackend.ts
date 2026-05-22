import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable, pipeline as pipelineCb } from 'stream';
import { promisify } from 'util';
import { LocalStorageBackend } from './LocalStorageBackend';
import { StoredObjectInfo } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

const pipeline = promisify(pipelineCb);

/**
 * NFS storage backend.
 *
 * Identical layout to LocalStorageBackend but overrides `write` to call
 * fsync before the atomic rename.  Without fsync, NFS clients can reorder
 * writes so the renamed destination may be seen by other nodes before all
 * bytes have been flushed from the page cache to the server — leading to
 * silent data corruption on a crash or network partition.
 *
 * Set NFS_MOUNT_PATH to the path where the NFS volume is mounted.
 * The volume must already be mounted before the process starts.
 */
export class NfsStorageBackend extends LocalStorageBackend {
  constructor() {
    super(config.storage.nfsRoot);
    logger.info('NfsStorageBackend initialized', { root: config.storage.nfsRoot });
  }

  override async write(
    storageKey: string,
    source: Readable,
    expectedSize?: number,
  ): Promise<StoredObjectInfo> {
    // Resolve relative to NFS root (inherited resolvePath uses this.root).
    const dest = path.join(config.storage.nfsRoot, storageKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const hash = crypto.createHash('md5');
    let size = 0;

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
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }

    if (expectedSize !== undefined && size !== expectedSize) {
      fs.rmSync(tmpPath, { force: true });
      throw new Error(`Size mismatch: expected ${expectedSize}, received ${size}`);
    }

    // fsync flushes the page cache to the NFS server before rename so that
    // any node reading the destination path sees a complete, consistent file.
    await this.fsyncFile(tmpPath);

    fs.renameSync(tmpPath, dest);

    return { storageKey, size, etag: hash.digest('hex') };
  }

  private async fsyncFile(filePath: string): Promise<void> {
    const fh = await fs.promises.open(filePath, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
}
