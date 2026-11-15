import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface NginxConfig {
  containerName: string;
  imageName: string;
  networkMode: string;
  httpPort: string;
  httpsPort: string;
  baseDir: string;
  nginxConf: string;
  nginxConfD: string;
  logsDir: string;
  letsencryptDir: string;
  sslCertsDir: string;
  wwwRootDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NginxConfig {
  const baseDir = env.BASE_DIR ?? resolve(__dirname, '..');
  return {
    containerName: env.CONTAINER_NAME ?? 'nginx',
    imageName: env.IMAGE_NAME ?? 'nginx:1.31.8-distroless',
    networkMode: env.NETWORK_MODE ?? 'host',
    httpPort: env.HTTP_PORT ?? '80',
    httpsPort: env.HTTPS_PORT ?? '443',
    baseDir,
    nginxConf: env.NGINX_CONF ?? resolve(baseDir, 'nginx.conf'),
    nginxConfD: env.NGINX_CONF_D ?? '/home/ubuntu/nginx.conf.d',
    logsDir: env.LOGS_DIR ?? resolve(baseDir, 'logs'),
    letsencryptDir: env.LETSENCRYPT_DIR ?? '/home/ubuntu/letsencrypt',
    sslCertsDir: env.SSL_CERTS_DIR ?? '/etc/letsencrypt',
    wwwRootDir: env.WWW_ROOT_DIR ?? '/home/ubuntu/src',
  };
}

