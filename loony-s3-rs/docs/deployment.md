# Deployment

## Building a release binary

```bash
cargo build --release
# Binary at: target/release/loony-s3
```

The binary is statically linked against musl on Linux (if you configure the target):

```bash
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

## Systemd service

```ini
# /etc/systemd/system/loony-s3.service
[Unit]
Description=loony-s3-rs object storage
After=network.target

[Service]
Type=simple
User=loony
WorkingDirectory=/opt/loony-s3
EnvironmentFile=/opt/loony-s3/.env
ExecStart=/opt/loony-s3/loony-s3
Restart=on-failure
RestartSec=5

# Graceful shutdown
TimeoutStopSec=40
KillMode=mixed
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now loony-s3
journalctl -u loony-s3 -f
```

## Docker

```dockerfile
FROM rust:1.78-slim as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/loony-s3 .
ENV PORT=3000
EXPOSE 3000
CMD ["./loony-s3"]
```

```bash
docker build -t loony-s3-rs .
docker run -d \
  -p 3000:3000 \
  -v /data/objects:/data/objects \
  -v /data/db:/data/db \
  -e STORAGE_ROOT=/data/objects \
  -e DB_PATH=/data/db/metadata.db \
  -e JWT_SECRET=change-me \
  loony-s3-rs
```

## Docker Compose with PostgreSQL

```yaml
# docker-compose.yml
version: "3.9"

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: loony_s3
      POSTGRES_USER: loony
      POSTGRES_PASSWORD: secret
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "loony"]
      interval: 5s

  app:
    image: loony-s3-rs
    build: .
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy
    environment:
      DB_BACKEND: postgres
      DATABASE_URL: postgresql://loony:secret@db:5432/loony_s3
      STORAGE_ROOT: /data/objects
      JWT_SECRET: change-me-in-production
      PRESIGNED_SECRET: another-strong-secret
      BASE_URL: http://localhost:3000
    volumes:
      - objdata:/data/objects

volumes:
  pgdata:
  objdata:
```

```bash
docker compose up -d
```

## Scaling

- Multiple app instances can share the **same PostgreSQL database** and the **same NFS volume**.
- Put a load balancer (nginx, Caddy, AWS ALB) in front.
- Rate limiting is **per-instance** — for distributed rate limiting, add Redis + a tower middleware.

## NFS storage

```env
STORAGE_BACKEND=nfs
NFS_MOUNT_PATH=/mnt/shared-storage
```

The NFS backend calls `fsync` before the atomic `rename`, preventing partial files from becoming visible to other nodes during a network partition.

## Production checklist

- [ ] Set strong `JWT_SECRET` and `PRESIGNED_SECRET` (32+ random bytes)
- [ ] Use PostgreSQL for multi-instance deployments
- [ ] Mount object storage on a persistent volume
- [ ] Configure `BASE_URL` to match your public hostname
- [ ] Set `RUST_LOG=info` (or `warn` in production) for structured logs
- [ ] Put TLS termination in a reverse proxy (nginx / Caddy / AWS ALB)
- [ ] Configure rate limits appropriate to your traffic
- [ ] Set up log shipping (e.g. to Loki, CloudWatch, Datadog)
