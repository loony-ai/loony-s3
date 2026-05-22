export const metrics = {
  startedAt: new Date(),

  requests: {
    total: 0,
    active: 0,
    errors4xx: 0,
    errors5xx: 0,
  },

  storage: {
    bytesUploaded: 0,
    bytesDownloaded: 0,
  },

  objects: {
    created: 0,
    deleted: 0,
    expired: 0,
  },

  cleanup: {
    staleUploadsRemoved: 0,
    expiredObjectsRemoved: 0,
    lastRunAt: null as Date | null,
  },
};

export function snapshot() {
  return {
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt.getTime()) / 1000),
    memory: process.memoryUsage(),
    ...metrics,
  };
}
