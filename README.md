# Nginx 1.31.8 Readonly Distroless Docker

This directory contains the Dockerfile, run script, configuration, and build setup for running Nginx 1.31.8 in a hardened, read-only Distroless container based on `gcr.io/distroless/base-debian12`.

## Files
- [`Dockerfile`](Dockerfile): Multi-stage build producing a ~13.8MB minimal distroless image with user `ubuntu:1000`.
- [`run.sh`](run.sh): Execution manager script supporting `start`, `stop`, `restart`, `test`, `reload`, `status`, `logs`, `cert`, and `install-hook`.
- [`nginx.conf`](nginx.conf): Nginx main configuration file.
- `logs/`: Shared log directory containing `access.log` and `error.log` (created automatically on startup).

## Quick Start

### 1. Build the Docker Image
```bash
docker build -t nginx:1.31.8-distroless .
```

### 2. Start the Container
```bash
./run.sh start
```
*(Runs with `--read-only`, tmpfs mounts for client/proxy buffers, host network mode to reach `127.0.0.1` reverse proxy targets, mounts `./logs` for host-shared logging, and ensures the Certbot renewal deploy hook is installed at `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`).*

### 3. Test Configuration (`nginx -t`)
To test configuration on the running container:
```bash
./run.sh test
# Or directly via docker:
docker exec nginx /usr/local/nginx/sbin/nginx -t
```
*(If the container is not currently running, `./run.sh test` will automatically spin up an ephemeral container to test your host configs).*

### 4. Reload Configuration Without Downtime
```bash
./run.sh reload
# Or directly via docker:
docker kill --signal=HUP nginx
```

### 5. Check Status and Logs
```bash
./run.sh status
./run.sh logs
# Direct log access on host:
tail -f logs/access.log logs/error.log
```

### 6. Stop Container
```bash
./run.sh stop
```

### 7. Acquire a New Let's Encrypt Certificate
```bash
./run.sh cert example.com
```
