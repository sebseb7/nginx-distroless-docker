# Nginx 1.31.9 Readonly Distroless Docker

This directory contains the Dockerfile, run script, configuration, and build setup for running Nginx 1.31.9 in a hardened, read-only Distroless container based on `gcr.io/distroless/base-debian12`.

## Files
- [`Dockerfile`](Dockerfile): Multi-stage build producing a ~13.8MB minimal distroless image with user `ubuntu:1000`.
- [`src/cli.tsx`](src/cli.tsx): Node.js + React + Ink + Chalk + Vite CLI & interactive TUI manager.
- [`run.sh`](run.sh): Original Bash execution manager script supporting `start`, `stop`, `restart`, `test`, `reload`, `status`, `logs`, `cert`, and `install-hook`.
- [`nginx.conf`](nginx.conf): Nginx main configuration file.
- `logs/`: Shared log directory containing `access.log` and `error.log` (created automatically on startup).

## Node.js / React Ink / Chalk / Vite CLI & TUI

### Build & Run
```bash
npm install
npm run build

# Launch Interactive TUI Dashboard (no args)
npm start
# or directly:
./dist/cli.js

# Run direct CLI subcommands
npm start -- status
npm start -- test
npm start -- reload
npm start -- start
npm start -- stop
npm start -- restart
npm start -- logs
npm start -- install-hook
npm start -- cert example.com

# Run in development mode via vite-node
npm run dev
npm run dev -- status
```

## Quick Start

### 1. Build the Docker Image
```bash
docker build -t nginx:1.31.9-distroless .
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
