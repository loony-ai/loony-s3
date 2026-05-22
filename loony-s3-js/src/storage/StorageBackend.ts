import { Readable } from 'stream';
import { StoredObjectInfo } from '../types';

/**
 * Pluggable storage abstraction.  Swap LocalStorageBackend for an S3Backend
 * or GCSBackend without touching any service layer code.
 */
export interface StorageBackend {
  /**
   * Write an object from a readable stream.
   * Returns the final storage key, byte count, and MD5 etag once the stream
   * has been fully consumed and flushed.
   */
  write(
    storageKey: string,
    source: Readable,
    expectedSize?: number,
  ): Promise<StoredObjectInfo>;

  /**
   * Open a readable stream for the object at storageKey.
   * If range is provided, only that byte range is streamed (for HTTP Range requests).
   */
  read(
    storageKey: string,
    range?: { start: number; end?: number },
  ): Promise<Readable>;

  /**
   * Return the byte size of the object at storageKey without reading it.
   */
  stat(storageKey: string): Promise<{ size: number }>;

  /**
   * Permanently remove the object at storageKey.
   */
  delete(storageKey: string): Promise<void>;

  /**
   * Concatenate ordered part storage keys into a single object.
   * Parts are removed after assembly to reclaim space.
   */
  assembleMultipart(
    partKeys: string[],
    destinationKey: string,
  ): Promise<StoredObjectInfo>;

  /**
   * Remove a set of part keys (abort multipart cleanup).
   */
  deleteParts(partKeys: string[]): Promise<void>;
}
