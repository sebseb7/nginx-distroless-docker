# Stage 1: Build Nginx 1.31.8 with specified configure flags
FROM debian:12-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    libpcre2-dev \
    libssl-dev \
    zlib1g-dev \
    libcrypt-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

ARG NGINX_VERSION=1.31.8
ARG NGINX_SHA256=0652b760b3b772d2ec17b47c2fc15d9a95e6fe35cd5b877eadc1a62d9bc75af1

RUN curl -fsSLO "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" \
 && echo "${NGINX_SHA256}  nginx-${NGINX_VERSION}.tar.gz" | sha256sum -c - \
 && tar -zxf "nginx-${NGINX_VERSION}.tar.gz" \
 && cd "nginx-${NGINX_VERSION}" \
 && ./configure \
      --with-http_ssl_module \
      --with-http_v2_module \
      --with-http_gzip_static_module \
      --without-http_ssi_module \
      --without-http_userid_module \
      --without-http_mirror_module \
      --without-http_autoindex_module \
      --without-http_geo_module \
      --without-http_split_clients_module \
      --without-http_referer_module \
      --without-http_fastcgi_module \
      --without-http_uwsgi_module \
      --without-http_scgi_module \
      --without-http_grpc_module \
      --without-http_tunnel_module \
      --without-http_memcached_module \
      --without-http_empty_gif_module \
      --without-http_browser_module \
      --without-http_upstream_hash_module \
      --without-http_upstream_ip_hash_module \
      --without-http_upstream_least_conn_module \
      --without-http_upstream_least_time_module \
      --without-http_upstream_random_module \
      --without-http_upstream_zone_module \
      --without-http_upstream_sticky_module \
 && make -j$(nproc) \
 && make install

# Resolve and collect runtime shared library dependencies
RUN mkdir -p /build/libs \
 && for lib in $(ldd /usr/local/nginx/sbin/nginx | awk '{if ($3 ~ /^\//) print $3; else if ($1 ~ /^\//) print $1}'); do \
      if [ -f "$lib" ]; then \
        dir=$(dirname "$lib"); \
        mkdir -p "/build/libs$dir"; \
        cp -L "$lib" "/build/libs$dir/"; \
      fi; \
    done

# Prepare minimal passwd and group with root, nobody, and ubuntu (uid 1000)
RUN mkdir -p /build/etc \
 && printf 'root:x:0:0:root:/root:/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin\nubuntu:x:1000:1000:ubuntu:/home/ubuntu:/sbin/nologin\n' > /build/etc/passwd \
 && printf 'root:x:0:\nnogroup:x:65534:\nubuntu:x:1000:\n' > /build/etc/group

# Create standard directories with ownership for ubuntu:ubuntu (1000:1000)
RUN mkdir -p /usr/local/nginx/logs \
             /usr/local/nginx/client_body_temp \
             /usr/local/nginx/proxy_temp \
             /home/ubuntu/letsencrypt \
             /home/ubuntu/nginx.conf.d \
 && chown -R 1000:1000 /usr/local/nginx/logs \
                       /usr/local/nginx/client_body_temp \
                       /usr/local/nginx/proxy_temp \
                       /home/ubuntu

# Stage 2: Minimal Readonly Distroless Image
FROM gcr.io/distroless/base-debian12:latest

# Copy minimal account entries
COPY --from=builder /build/etc/passwd /etc/passwd
COPY --from=builder /build/etc/group /etc/group

# Copy collected shared libraries
COPY --from=builder /build/libs/ /

# Copy compiled Nginx prefix (binary, conf, mime.types, html)
COPY --from=builder /usr/local/nginx /usr/local/nginx

# Copy user directory structure
COPY --from=builder --chown=1000:1000 /home/ubuntu /home/ubuntu

# Copy user-provided nginx.conf into place
COPY nginx.conf /usr/local/nginx/conf/nginx.conf

WORKDIR /usr/local/nginx

EXPOSE 80 443

STOPSIGNAL SIGQUIT

ENTRYPOINT ["/usr/local/nginx/sbin/nginx"]
CMD ["-g", "daemon off;"]
