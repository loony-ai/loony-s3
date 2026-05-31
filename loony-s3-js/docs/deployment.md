# Deployment Guide

Three deployment modes are supported, ordered from simplest to most scalable.

| Mode | DB | Storage | Scales to |
|---|---|---|---|
| [Bare metal (single server)](#1-bare-metal-single-server) | SQLite | Local disk | ~100M objects |
| [Docker Compose (single server)](#2-docker-compose-single-server) | PostgreSQL | Docker volume | ~500M objects |
| [Docker Compose (multi-server)](#3-docker-compose-multi-server) | PostgreSQL | NFS / shared volume | ~1B objects |

---

## Prerequisites

- **Node.js 24+** (bare metal only) — required for the built-in `node:sqlite` module
- **Docker + Docker Compose v2** (Docker modes)
- **openssl** — for generating secrets
- **psql** (optional) — for inspecting the PostgreSQL database

---

## 1. Bare Metal (Single Server)

Best for: development, small deployments, machines without Docker.

### 1.1 Install and build

```bash
git clone <repo>
cd loony-s3-js
npm ci
npm run build
```

### 1.2 Create directories

```bash
sudo mkdir -p /var/data/loony-s3/objects
sudo mkdir -p /var/data/loony-s3/db
sudo chown -R $USER /var/data/loony-s3
```

### 1.3 Configure environment

```bash
cp .env.production.example .env.production

# Generate secrets (interactive)
./scripts/generate-secrets.sh >> .env.production
```

Edit `.env.production` and set `BASE_URL` to your public domain or IP.

### 1.4 Run as a systemd service

Copy the service file and enable it:

```bash
sudo cp deploy/loony-s3.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now loony-s3
sudo systemctl status loony-s3
```

View logs:

```bash
journalctl -u loony-s3 -f
```

### 1.5 Verify

```bash
./scripts/healthcheck.sh http://localhost:3000
```

---

## 2. Docker Compose (Single Server)

Best for: production single-server deployments. PostgreSQL is used instead of SQLite.

### 2.1 Configure secrets

```bash
cp .env.production.example .env
./scripts/generate-secrets.sh >> .env
```

Edit `.env` and set:
- `BASE_URL` — your public URL (e.g. `https://s3.yourdomain.com`)
- `POSTGRES_PASSWORD` — a strong password

### 2.2 Start

```bash
docker compose up -d
```

Services started:
- `postgres` — PostgreSQL 16 with a persistent volume
- `app` — loony-s3-js on port 3000 (internal only)
- `nginx` — public entry point on port 80

### 2.3 Verify

```bash
./scripts/healthcheck.sh http://localhost
docker compose ps
docker compose logs app --tail=50
```

### 2.4 Persistent data

| Data | Location |
|---|---|
| Object files | `objdata` Docker volume → `/data/objects` inside container |
| PostgreSQL data | `pgdata` Docker volume |

To back up the object store:

```bash
docker run --rm \
  -v loony-s3-js_objdata:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/objects-$(date +%Y%m%d).tar.gz -C /data .
```

To back up PostgreSQL:

```bash
docker compose exec postgres \
  pg_dump -U loony loony_s3 | gzip > backups/db-$(date +%Y%m%d).sql.gz
```

---

## 3. Docker Compose (Multi-Server)

Best for: high-traffic or high-availability deployments. All instances share PostgreSQL for metadata and an NFS mount for object storage.

### 3.1 Requirements

- A shared NFS volume mounted at the same path on every host (e.g. `/mnt/loony-s3-data`)
- A reachable PostgreSQL server (can be managed: RDS, Supabase, Neon, etc.)
- A load balancer in front of all app instances (nginx, Caddy, or a cloud LB)

### 3.2 Configure

```bash
cp .env.production.example .env
```

Set in `.env`:

```env
DB_BACKEND=postgres
DATABASE_URL=postgresql://loony:<password>@<postgres-host>:5432/loony_s3

STORAGE_BACKEND=nfs
STORAGE_ROOT=/mnt/loony-s3-data/objects

BASE_URL=https://s3.yourdomain.com
JWT_SECRET=<same value on all servers>
PRESIGNED_SECRET=<same value on all servers>
```

> **JWT_SECRET and PRESIGNED_SECRET must be identical on every instance.**
> Generate once: `openssl rand -hex 32` and copy the output to all servers.

### 3.3 Mount the NFS share on every host

```bash
# /etc/fstab entry (adjust to your NFS server)
<nfs-server>:/exports/loony-s3  /mnt/loony-s3-data  nfs  defaults,_netdev  0 0

sudo mount -a
sudo mkdir -p /mnt/loony-s3-data/objects/__tmp
```

### 3.4 Start with multiple app replicas

On each host:

```bash
docker compose up -d --scale app=3
```

Or using a single host to test scaling:

```bash
docker compose up -d --scale app=3
```

nginx round-robins across all replicas. Docker Compose's internal DNS (`app:3000`) resolves to all running containers.

### 3.5 Health checks

nginx exposes a dedicated health endpoint that bypasses the app:

```bash
curl http://<host>/nginx-health   # → "ok"
```

App health:

```bash
curl http://<host>/health         # → { status, uptime, memory, ... }
```

---

## Nginx (HTTPS / TLS)

To enable HTTPS, update `nginx/nginx.conf`:

```nginx
server {
    listen 80;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    # ... rest of config unchanged
}
```

Mount your certificates into the nginx container:

```yaml
# docker-compose.yml
nginx:
  volumes:
    - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    - /etc/letsencrypt/live/yourdomain.com:/etc/nginx/certs:ro
```

With Certbot (Let's Encrypt):

```bash
sudo certbot certonly --standalone -d s3.yourdomain.com
```

---

## Environment Variables Reference

See [configuration.md](configuration.md) for the full list. Key production variables:

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | `openssl rand -hex 32` |
| `PRESIGNED_SECRET` | Yes | `openssl rand -hex 32` |
| `BASE_URL` | Yes | Public URL of the server (used in presigned URLs) |
| `DB_BACKEND` | No | `sqlite` (default) or `postgres` |
| `DATABASE_URL` | If postgres | `postgresql://user:pass@host:5432/db` |
| `STORAGE_BACKEND` | No | `local` (default) or `nfs` |
| `STORAGE_ROOT` | No | Path for object files (avoid `/tmp` in production) |
| `NODE_ENV` | No | Set to `production` for JSON logs |

---

## Upgrade

```bash
# Bare metal
git pull
npm ci
npm run build
sudo systemctl restart loony-s3

# Docker Compose
git pull
docker compose build app
docker compose up -d
```

The database schema is migrated automatically on startup. No manual migration steps are needed.

---

## Reset (wipe all data)

```bash
# Stop the server first
sudo systemctl stop loony-s3         # bare metal
docker compose down                   # Docker

# Wipe
./scripts/reset.sh

# Restart
sudo systemctl start loony-s3
docker compose up -d
```

See [reset.sh](../scripts/reset.sh) for NFS and PostgreSQL variants.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required env var: JWT_SECRET` | `.env` not loaded | Pass env file: `node -r dotenv/config dist/server.js` |
| `SQLITE_BUSY` on writes | Another process holds the write lock | Set `BUSY_TIMEOUT=5000` or switch to `DB_BACKEND=postgres` |
| `ENOENT` on object write | `STORAGE_ROOT` directory missing | `mkdir -p $STORAGE_ROOT/__tmp` |
| Upload hangs at nginx | `client_max_body_size` too small | Increase in `nginx/nginx.conf` (default 5 GB) |
| Presigned URL 401 | `PRESIGNED_SECRET` differs across instances | Use the same secret on all nodes |
| Port 80 in use | Another process bound to port 80 | Change `ports` in `docker-compose.yml` or stop the other process |
