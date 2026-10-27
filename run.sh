#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration Variables (override via environment if needed)
# -----------------------------------------------------------------------------
CONTAINER_NAME="${CONTAINER_NAME:-nginx}"
IMAGE_NAME="${IMAGE_NAME:-nginx:1.31.8-distroless}"
NETWORK_MODE="${NETWORK_MODE:-host}" # "host" enables 127.0.0.1 proxy passes; set to "bridge" to use -p
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"

# Host directory paths
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_CONF="${NGINX_CONF:-$BASE_DIR/nginx.conf}"
NGINX_CONF_D="${NGINX_CONF_D:-/home/ubuntu/nginx.conf.d}"
LOGS_DIR="${LOGS_DIR:-$BASE_DIR/logs}"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/home/ubuntu/letsencrypt}"
SSL_CERTS_DIR="${SSL_CERTS_DIR:-/etc/letsencrypt}"
WWW_ROOT_DIR="${WWW_ROOT_DIR:-/home/ubuntu/src}"

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------
ensure_dirs() {
    mkdir -p "$LOGS_DIR"
    mkdir -p "$LETSENCRYPT_DIR"
    mkdir -p "$NGINX_CONF_D"
}

ensure_certbot_hook() {
    local hook_dir="${SSL_CERTS_DIR}/renewal-hooks/deploy"
    local hook_file="${hook_dir}/reload-nginx.sh"
    if [ -d "${SSL_CERTS_DIR}" ] || sudo test -d "${SSL_CERTS_DIR}" 2>/dev/null; then
        if ! sudo test -x "${hook_file}" 2>/dev/null; then
            echo "[*] Installing Certbot deploy hook at ${hook_file}..."
            sudo mkdir -p "${hook_dir}"
            sudo tee "${hook_file}" > /dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
"${BASE_DIR}/run.sh" reload
EOF
            sudo chmod +x "${hook_file}"
            echo "[+] Certbot deploy hook installed."
        fi
    fi
}

start_container() {
    ensure_dirs
    ensure_certbot_hook

    if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
        echo "[!] Container '${CONTAINER_NAME}' already exists. Stopping and removing..."
        docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
        docker rm "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    fi

    echo "[*] Starting readonly distroless Nginx container '${CONTAINER_NAME}'..."

    # Common volume and tmpfs arguments for readonly runtime
    DOCKER_ARGS=(
        run -d
        --name "${CONTAINER_NAME}"
        --restart unless-stopped
        --read-only
        --stop-signal SIGQUIT
        --cap-add NET_BIND_SERVICE
        --tmpfs /tmp:rw,nosuid,nodev,size=64m
        --tmpfs /usr/local/nginx/client_body_temp:rw,uid=1000,gid=1000,mode=0700,size=256m
        --tmpfs /usr/local/nginx/proxy_temp:rw,uid=1000,gid=1000,mode=0700,size=256m
        -v "${LOGS_DIR}:/usr/local/nginx/logs"
        -v "${NGINX_CONF}:/usr/local/nginx/conf/nginx.conf:ro"
        -v "${NGINX_CONF_D}:/home/ubuntu/nginx.conf.d:ro"
        -v "${LETSENCRYPT_DIR}:/home/ubuntu/letsencrypt:ro"
    )

    # Mount SSL certificates directory if present on host
    if [ -d "${SSL_CERTS_DIR}" ]; then
        DOCKER_ARGS+=(-v "${SSL_CERTS_DIR}:/etc/letsencrypt:ro")
    fi

    # Mount static web sources if present on host
    if [ -d "${WWW_ROOT_DIR}" ]; then
        DOCKER_ARGS+=(-v "${WWW_ROOT_DIR}:/home/ubuntu/src:ro")
    fi

    # Network configuration
    if [ "${NETWORK_MODE}" = "host" ]; then
        DOCKER_ARGS+=(--net=host)
    else
        DOCKER_ARGS+=(-p "${HTTP_PORT}:80" -p "${HTTPS_PORT}:443")
    fi

    DOCKER_ARGS+=("${IMAGE_NAME}")

    docker "${DOCKER_ARGS[@]}"

    echo "[+] Nginx container '${CONTAINER_NAME}' started successfully."
    echo "    - Logs directory: ${LOGS_DIR}"
    echo "    - Config file:    ${NGINX_CONF}"
}

test_config() {
    if docker ps --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
        echo "[*] Testing configuration on running container '${CONTAINER_NAME}'..."
        docker exec "${CONTAINER_NAME}" /usr/local/nginx/sbin/nginx -t
    else
        echo "[*] Container not running. Testing configuration in ephemeral container..."
        ensure_dirs
        TEST_ARGS=(
            run --rm
            -v "${NGINX_CONF}:/usr/local/nginx/conf/nginx.conf:ro"
            -v "${NGINX_CONF_D}:/home/ubuntu/nginx.conf.d:ro"
            -v "${LETSENCRYPT_DIR}:/home/ubuntu/letsencrypt:ro"
        )
        if [ -d "${SSL_CERTS_DIR}" ]; then
            TEST_ARGS+=(-v "${SSL_CERTS_DIR}:/etc/letsencrypt:ro")
        fi
        if [ -d "${WWW_ROOT_DIR}" ]; then
            TEST_ARGS+=(-v "${WWW_ROOT_DIR}:/home/ubuntu/src:ro")
        fi
        TEST_ARGS+=("${IMAGE_NAME}" -t)
        docker "${TEST_ARGS[@]}"
    fi
}

reload_nginx() {
    echo "[*] Testing configuration before reload..."
    test_config
    echo "[*] Reloading Nginx configuration via SIGHUP..."
    docker kill --signal=HUP "${CONTAINER_NAME}"
    echo "[+] Configuration reloaded."
}

stop_container() {
    echo "[*] Stopping container '${CONTAINER_NAME}'..."
    docker stop "${CONTAINER_NAME}"
    docker rm "${CONTAINER_NAME}"
    echo "[+] Container '${CONTAINER_NAME}' stopped and removed."
}

status_container() {
    docker ps -f name="^${CONTAINER_NAME}\$"
}

acquire_cert() {
    local domain="${1:-}"
    if [ -z "$domain" ]; then
        echo "Usage: $0 cert <domain> [additional-domains...]"
        exit 1
    fi
    ensure_dirs
    ensure_certbot_hook

    local domain_args=()
    for d in "$@"; do
        domain_args+=(-d "$d")
    done

    echo "[*] Requesting Let's Encrypt certificate for: $*"
    sudo certbot certonly --webroot -w "${LETSENCRYPT_DIR}" "${domain_args[@]}"
}

# -----------------------------------------------------------------------------
# Command Dispatcher
# -----------------------------------------------------------------------------
COMMAND="${1:-start}"

case "$COMMAND" in
    start)
        start_container
        ;;
    stop)
        stop_container
        ;;
    restart)
        stop_container || true
        start_container
        ;;
    test)
        test_config
        ;;
    reload)
        reload_nginx
        ;;
    status)
        status_container
        ;;
    logs)
        tail -f "${LOGS_DIR}/access.log" "${LOGS_DIR}/error.log" 2>/dev/null || docker logs -f "${CONTAINER_NAME}"
        ;;
    install-hook)
        ensure_certbot_hook
        ;;
    cert)
        shift
        acquire_cert "$@"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|test|reload|status|logs|cert|install-hook}"
        exit 1
        ;;
esac
