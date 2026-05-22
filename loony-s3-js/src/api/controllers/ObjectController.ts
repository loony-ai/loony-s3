import { Request, Response } from 'express';
import busboy from 'busboy';
import { z } from 'zod';
import { Readable } from 'stream';
import { ObjectService } from '../../services/ObjectService';
import { MultipartUploadService } from '../../services/MultipartUploadService';
import { PresignedUrlService } from '../../services/PresignedUrlService';
import { IBucketRepository } from '../../repositories/interfaces';
import { AppError } from '../../utils/AppError';
import { ObjectACL, PresignedOperation, StoredObject } from '../../types';
import { logger } from '../../utils/logger';

const PresignedUrlSchema = z.object({
  key: z.string().min(1).max(1024),
  operation: z.enum(['GET', 'PUT', 'DELETE']),
  expiresInSeconds: z.number().int().min(1).max(604800),
  metadata: z.record(z.string()).optional(),
});

const CompleteMultipartSchema = z.object({
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1).max(10000),
      etag: z.string(),
    }),
  ).min(1),
});

export class ObjectController {
  constructor(
    private readonly objectService: ObjectService,
    private readonly multipartService: MultipartUploadService,
    private readonly presignedService: PresignedUrlService,
    private readonly bucketRepo: IBucketRepository,
  ) {}

  // ─── Single-part operations ───────────────────────────────────────────────

  /**
   * PUT /{bucket}/{key}
   * Streaming upload using busboy for multipart/form-data OR raw body for
   * application/* content types.  Handles files of arbitrary size without
   * buffering the entire body in memory.
   */
  putObject = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName, key } = req.params as { bucket: string; key: string };
    const acl = (req.headers['x-acl'] ?? 'private') as ObjectACL;
    const metadata = this.extractCustomMetadata(req);
    const ttlSeconds = req.headers['x-ttl-seconds']
      ? parseInt(req.headers['x-ttl-seconds'] as string, 10)
      : undefined;

    const contentType = req.headers['content-type'] ?? '';
    const contentLength = req.headers['content-length']
      ? parseInt(req.headers['content-length'], 10)
      : undefined;

    let objectStream: Readable;
    let resolvedMime: string | undefined;
    let resolvedLength: number | undefined = contentLength;

    if (contentType.startsWith('multipart/form-data')) {
      // Client sent a multipart/form-data with the file in a "file" field.
      const { stream, mimeType, size } = await this.extractMultipartStream(req);
      objectStream = stream;
      resolvedMime = mimeType;
      resolvedLength = size ?? resolvedLength;
    } else {
      // Raw binary body (e.g. application/octet-stream or the file's native type).
      objectStream = req;
      resolvedMime = contentType || undefined;
    }

    const obj = await this.objectService.putObject({
      bucketName,
      key,
      stream: objectStream,
      mimeType: resolvedMime,
      contentLength: resolvedLength,
      acl,
      metadata,
      requesterId,
      ttlSeconds,
    });

    res.setHeader('ETag', `"${obj.etag}"`);
    res.setHeader('x-version-id', obj.versionId);
    res.status(200).json({ object: this.formatObject(obj) });
  };

  /**
   * GET /{bucket}/{key}
   * Streaming download, supports HTTP Range requests.
   */
  getObject = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName, key } = req.params as { bucket: string; key: string };
    const versionId = req.query['versionId'] as string | undefined;

    const rangeHeader = req.headers['range'];
    let range: { start: number; end?: number } | undefined;

    if (rangeHeader) {
      range = this.parseRangeHeader(rangeHeader);
    }

    const { object, stream } = await this.objectService.getObject({
      bucketName,
      key,
      versionId,
      range,
      requesterId,
    });

    // Resolve open-ended range (e.g. "bytes=0-") to actual last byte
    const effectiveEnd = range ? (range.end ?? object.size - 1) : undefined;

    res.setHeader('Content-Type', object.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', range ? effectiveEnd! - range.start + 1 : object.size);
    res.setHeader('ETag', `"${object.etag}"`);
    res.setHeader('Last-Modified', object.updatedAt.toUTCString());
    res.setHeader('x-version-id', object.versionId);

    // Expose custom metadata as x-meta-* headers.
    for (const [k, v] of Object.entries(object.metadata)) {
      res.setHeader(`x-meta-${k}`, v);
    }

    if (range) {
      res.setHeader('Content-Range', `bytes ${range.start}-${effectiveEnd}/${object.size}`);
      res.status(206);
    } else {
      res.status(200);
    }

    stream.pipe(res);

    stream.on('error', (err) => {
      logger.error('Stream error during download', { err, key, bucketName });
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  };

  /**
   * HEAD /{bucket}/{key}
   * Returns metadata only (no body).
   */
  headObject = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName, key } = req.params as { bucket: string; key: string };

    const obj = await this.objectService.headObject(bucketName, key, requesterId);

    res.setHeader('Content-Type', obj.mimeType);
    res.setHeader('Content-Length', obj.size);
    res.setHeader('ETag', `"${obj.etag}"`);
    res.setHeader('Last-Modified', obj.updatedAt.toUTCString());
    res.setHeader('x-version-id', obj.versionId);
    res.setHeader('x-object-size', obj.size);

    for (const [k, v] of Object.entries(obj.metadata)) {
      res.setHeader(`x-meta-${k}`, v);
    }

    res.status(200).end();
  };

  /**
   * GET /{bucket}?list=true
   * List objects with optional prefix/delimiter/pagination.
   */
  listObjects = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName } = req.params as { bucket: string };

    const result = await this.objectService.listObjects(
      bucketName,
      {
        prefix: req.query['prefix'] as string | undefined,
        delimiter: req.query['delimiter'] as string | undefined,
        maxKeys: req.query['maxKeys'] ? parseInt(req.query['maxKeys'] as string, 10) : undefined,
        continuationToken: req.query['continuationToken'] as string | undefined,
      },
      requesterId,
    );

    res.json({
      ...result,
      objects: result.objects.map(this.formatObject),
    });
  };

  /**
   * DELETE /{bucket}/{key}
   */
  deleteObject = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName, key } = req.params as { bucket: string; key: string };
    const versionId = req.query['versionId'] as string | undefined;

    await this.objectService.deleteObject(bucketName, key, requesterId, versionId);
    res.status(204).end();
  };

  // ─── Multipart ────────────────────────────────────────────────────────────

  /**
   * POST /{bucket}/{key}?uploads
   * Initiate a multipart upload.
   */
  initiateMultipartUpload = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName, key } = req.params as { bucket: string; key: string };
    const metadata = this.extractCustomMetadata(req);

    const upload = await this.multipartService.initiateUpload(
      bucketName,
      key,
      requesterId,
      metadata,
    );

    res.status(200).json({ uploadId: upload.uploadId, key, bucket: bucketName });
  };

  /**
   * PUT /{bucket}/{key}?partNumber=N&uploadId=X
   * Upload a part. Raw streaming — no buffering.
   */
  uploadPart = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: _b, key: _k } = req.params as { bucket: string; key: string };
    const uploadId = req.query['uploadId'] as string;
    const partNumber = parseInt(req.query['partNumber'] as string, 10);
    const contentLength = req.headers['content-length']
      ? parseInt(req.headers['content-length'], 10)
      : undefined;

    if (!uploadId) throw new AppError('UPLOAD_NOT_FOUND', 'uploadId query param is required');

    const part = await this.multipartService.uploadPart(
      uploadId,
      partNumber,
      req,
      requesterId,
      contentLength,
    );

    res.setHeader('ETag', `"${part.etag}"`);
    res.status(200).json({ partNumber: part.partNumber, etag: part.etag, size: part.size });
  };

  /**
   * POST /{bucket}/{key}?uploadId=X
   * Complete a multipart upload.
   */
  completeMultipartUpload = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName, key } = req.params as { bucket: string; key: string };
    const uploadId = req.query['uploadId'] as string;
    const acl = (req.headers['x-acl'] ?? 'private') as ObjectACL;

    if (!uploadId) throw new AppError('UPLOAD_NOT_FOUND', 'uploadId query param is required');

    const body = CompleteMultipartSchema.parse(req.body);
    const obj = await this.multipartService.completeUpload(uploadId, body, requesterId, acl);

    res.status(200).json({ object: this.formatObject(obj) });
  };

  /**
   * DELETE /{bucket}/{key}?uploadId=X
   * Abort a multipart upload.
   */
  abortMultipartUpload = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const uploadId = req.query['uploadId'] as string;
    if (!uploadId) throw new AppError('UPLOAD_NOT_FOUND', 'uploadId is required');

    await this.multipartService.abortUpload(uploadId, requesterId);
    res.status(204).end();
  };

  /**
   * GET /{bucket}/{key}?uploadId=X&parts=true
   */
  listParts = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const uploadId = req.query['uploadId'] as string;
    if (!uploadId) throw new AppError('UPLOAD_NOT_FOUND', 'uploadId is required');

    const parts = await this.multipartService.listParts(uploadId, requesterId);
    res.json({ parts });
  };

  // ─── Pre-signed URLs ──────────────────────────────────────────────────────

  /**
   * POST /{bucket}/presign
   * Generate a pre-signed URL for secure temporary access.
   */
  generatePresignedUrl = async (req: Request, res: Response): Promise<void> => {
    const requesterId = this.resolveRequesterId(req);
    const { bucket: bucketName } = req.params as { bucket: string };

    const body = PresignedUrlSchema.parse(req.body);
    const result = await this.presignedService.generate(
      { ...body, bucketName },
      requesterId,
    );

    res.status(200).json(result);
  };

  /**
   * ANY /presigned/{bucket}/{key}
   * Validate and proxy a presigned request through to the actual operation.
   */
  handlePresignedRequest = async (req: Request, res: Response): Promise<void> => {
    const { bucket: bucketName, key } = req.params as { bucket: string; key: string };
    const operation = req.query['X-Operation'] as PresignedOperation;
    const expires = req.query['X-Expires'] as string;
    const signature = req.query['X-Signature'] as string;

    if (!operation || !expires || !signature) {
      throw new AppError('PRESIGNED_URL_INVALID', 'Missing required presigned URL parameters');
    }

    this.presignedService.validate(bucketName, key, operation, expires, signature);

    // Presigned URLs are generated by the bucket owner, so we impersonate
    // the owner so that downstream ACL checks pass transparently.
    const bucket = await this.bucketRepo.findByName(bucketName);
    if (!bucket) throw new AppError('BUCKET_NOT_FOUND', `Bucket '${bucketName}' not found`);
    req.user = { id: bucket.ownerId, email: 'presigned@internal' };

    // Route to the appropriate handler based on the authorized operation.
    if (operation === 'GET') {
      await this.getObject(req, res);
    } else if (operation === 'PUT') {
      await this.putObject(req, res);
    } else if (operation === 'DELETE') {
      await this.deleteObject(req, res);
    }
  };

  // ─── Private helpers ──────────────────────────────────────────────────────

  private resolveRequesterId(req: Request): string {
    if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required');
    return req.user.id;
  }

  private extractCustomMetadata(req: Request): Record<string, string> {
    const meta: Record<string, string> = {};
    for (const [header, value] of Object.entries(req.headers)) {
      if (header.startsWith('x-meta-') && typeof value === 'string') {
        meta[header.slice('x-meta-'.length)] = value;
      }
    }
    return meta;
  }

  /**
   * Extract the first file field from a multipart/form-data upload using
   * busboy without buffering into memory.  Returns a stream, detected MIME
   * type, and transfer size if the client sent Content-Length.
   */
  private extractMultipartStream(
    req: Request,
  ): Promise<{ stream: Readable; mimeType?: string; size?: number }> {
    return new Promise((resolve, reject) => {
      const bb = busboy({
        headers: req.headers,
        limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB guard
      });

      let resolved = false;

      bb.on('file', (_name, fileStream, info) => {
        if (resolved) {
          // Drain extra files we don't care about.
          fileStream.resume();
          return;
        }
        resolved = true;
        const mimeType = info.mimeType !== 'application/octet-stream'
          ? info.mimeType
          : undefined;
        resolve({ stream: fileStream, mimeType });
      });

      bb.on('error', reject);
      bb.on('finish', () => {
        if (!resolved) reject(new AppError('INTERNAL_ERROR', 'No file field found in upload'));
      });

      req.pipe(bb);
    });
  }

  private parseRangeHeader(header: string): { start: number; end?: number } {
    // Browsers send "bytes=0-" (open-ended) or "bytes=0-1023" (explicit)
    const match = /bytes=(\d+)-(\d*)/.exec(header);
    if (!match) throw new AppError('INTERNAL_ERROR', 'Invalid Range header format');
    const start = parseInt(match[1]!, 10);
    const end   = match[2] ? parseInt(match[2], 10) : undefined;
    return end !== undefined ? { start, end } : { start };
  }

  private formatObject(obj: StoredObject) {
    return {
      key: obj.key,
      size: obj.size,
      mimeType: obj.mimeType,
      etag: obj.etag,
      versionId: obj.versionId,
      isLatest: obj.isLatest,
      acl: obj.acl,
      metadata: obj.metadata,
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
      expiresAt: obj.expiresAt,
    };
  }
}
