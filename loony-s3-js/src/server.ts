import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { snapshot as metricsSnapshot } from './utils/metrics';

// Storage backends
import { LocalStorageBackend } from './storage/LocalStorageBackend';
import { NfsStorageBackend } from './storage/NfsStorageBackend';
import { StorageBackend } from './storage/StorageBackend';

// Repositories — SQLite
import { SqliteBucketRepository } from './repositories/sqlite/BucketRepository';
import { SqliteObjectRepository } from './repositories/sqlite/ObjectRepository';

// Repositories — PostgreSQL
import { PostgresBucketRepository } from './repositories/postgres/BucketRepository';
import { PostgresObjectRepository } from './repositories/postgres/ObjectRepository';

// Repository interfaces
import { IBucketRepository, IObjectRepository } from './repositories/interfaces';

// DB init/close helpers
import { initDb, closeDb, getDb } from './db/database';
import { initPostgres, closePool, getPool } from './db/postgres';

// Services
import { BucketService } from './services/BucketService';
import { ObjectService } from './services/ObjectService';
import { MultipartUploadService } from './services/MultipartUploadService';
import { PresignedUrlService } from './services/PresignedUrlService';
import { CleanupService } from './services/CleanupService';

// Controllers
import { BucketController } from './api/controllers/BucketController';
import { ObjectController } from './api/controllers/ObjectController';

// Routes
import { createBucketRouter } from './api/routes/buckets';
import { createObjectRouter } from './api/routes/objects';
import { createAuthRouter } from './api/routes/auth';

// Middleware
import { requestId } from './api/middleware/requestId';
import { requestLogger } from './api/middleware/requestLogger';
import { errorHandler } from './api/middleware/errorHandler';
import { authRateLimiter, generalRateLimiter } from './api/middleware/rateLimiter';

async function bootstrap(): Promise<void> {
  // ── Storage backend ──────────────────────────────────────────────────────
  let storageBackend: StorageBackend;

  if (config.storage.backend === 'nfs') {
    storageBackend = new NfsStorageBackend();
    logger.info('Using NFS storage backend');
  } else {
    storageBackend = new LocalStorageBackend();
    logger.info('Using local filesystem storage backend');
  }

  // ── Repositories ─────────────────────────────────────────────────────────
  let bucketRepo: IBucketRepository;
  let objectRepo: IObjectRepository;

  if (config.db.backend === 'postgres') {
    await initPostgres();
    bucketRepo = new PostgresBucketRepository();
    objectRepo = new PostgresObjectRepository();
    logger.info('Using PostgreSQL metadata backend');
  } else {
    initDb();
    bucketRepo = new SqliteBucketRepository();
    objectRepo = new SqliteObjectRepository();
    logger.info('Using SQLite metadata backend');
  }

  // ── Services ──────────────────────────────────────────────────────────────
  const bucketService = new BucketService(bucketRepo, objectRepo);
  const objectService = new ObjectService(bucketRepo, objectRepo, storageBackend, bucketService);
  const multipartService = new MultipartUploadService(bucketRepo, objectRepo, storageBackend, bucketService);
  const presignedService = new PresignedUrlService(bucketRepo);
  const cleanupService = new CleanupService(objectRepo, storageBackend);

  // ── Controllers ───────────────────────────────────────────────────────────
  const bucketController = new BucketController(bucketService);
  const objectController = new ObjectController(objectService, multipartService, presignedService, bucketRepo);

  // ── Express app ───────────────────────────────────────────────────────────
  const app = express();

  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(requestId);                            // attach x-request-id first
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);
  app.use(generalRateLimiter);                   // global catch-all rate limit

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', async (_req, res) => {
    const checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; message?: string }> = {};

    // DB liveness
    const dbStart = Date.now();
    try {
      if (config.db.backend === 'postgres') {
        await getPool().query('SELECT 1');
      } else {
        getDb().prepare('SELECT 1').get();
      }
      checks['db'] = { status: 'ok', latencyMs: Date.now() - dbStart };
    } catch (err) {
      checks['db'] = { status: 'error', latencyMs: Date.now() - dbStart, message: String(err) };
    }

    const healthy = Object.values(checks).every((c) => c.status === 'ok');
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────
  app.get('/metrics', (_req, res) => {
    res.json(metricsSnapshot());
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/auth', authRateLimiter, createAuthRouter());
  app.use('/buckets', generalRateLimiter, createBucketRouter(bucketController));

  // Object routes: apply tighter limits per verb inside the router.
  // Upload (PUT) and download (GET) get their own windows.
  const objectRouter = createObjectRouter(objectController);
  app.use('/', objectRouter);

  // ── Error handler (must be last) ──────────────────────────────────────────
  app.use(errorHandler);

  // ── HTTP server ───────────────────────────────────────────────────────────
  const server = app.listen(config.port, () => {
    logger.info(`loony-s3 listening on port ${config.port}`, {
      env: config.nodeEnv,
      storage: config.storage.backend,
      db: config.db.backend,
    });
  });

  // ── Background cleanup workers ────────────────────────────────────────────
  const cleanupTimers: NodeJS.Timeout[] = [];

  cleanupTimers.push(
    setInterval(async () => {
      try {
        const n = await cleanupService.cleanExpiredObjects();
        if (n > 0) logger.info(`Cleanup: removed ${n} expired object(s)`);
      } catch (err) {
        logger.error('Cleanup: expired objects run failed', { err });
      }
    }, config.cleanup.expiredObjectsIntervalMs),
  );

  cleanupTimers.push(
    setInterval(async () => {
      try {
        const n = await cleanupService.cleanStaleMultipartUploads();
        if (n > 0) logger.info(`Cleanup: aborted ${n} stale multipart upload(s)`);
      } catch (err) {
        logger.error('Cleanup: stale uploads run failed', { err });
      }
    }, config.cleanup.staleUploadsIntervalMs),
  );

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal} — starting graceful shutdown`);

    // Stop background workers immediately.
    cleanupTimers.forEach(clearInterval);

    server.close(async () => {
      logger.info('HTTP server closed — no new connections accepted');

      try {
        if (config.db.backend === 'postgres') {
          await closePool();
        } else {
          closeDb();
        }
      } catch (err) {
        logger.error('Error closing database during shutdown', { err });
      }

      logger.info('Graceful shutdown complete');
      process.exit(0);
    });

    // After drainTimeoutMs, destroy keep-alive connections that are still
    // idle — prevents the server from hanging when clients hold open sockets.
    setTimeout(() => {
      logger.warn('Drain timeout reached — destroying idle connections');
      server.closeAllConnections?.();
    }, config.shutdown.drainTimeoutMs).unref();

    // Hard kill after forceExitTimeoutMs regardless of what's still in-flight.
    setTimeout(() => {
      logger.error('Force exit timeout reached — killing process');
      process.exit(1);
    }, config.shutdown.forceExitTimeoutMs).unref();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('Failed to start server', { err });
  process.exit(1);
});
