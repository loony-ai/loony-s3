import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { createReadStream } from 'fs';

export function md5Hex(data: Buffer | string): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

export function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function randomId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Stream-compute MD5 of a file without loading it into memory. */
export async function md5OfFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('md5');
  const src = createReadStream(filePath);
  await pipeline(src, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield chunk;
    }
  }, async function* (source) {
    // consume
    for await (const _ of source) { /* drain */ }
  });
  return hash.digest('hex');
}

/** Safer version that computes MD5 while also returning a transform stream. */
export function createMd5Stream(): {
  hash: crypto.Hash;
  finalize: () => string;
} {
  const hash = crypto.createHash('md5');
  return {
    hash,
    finalize: () => hash.digest('hex'),
  };
}
