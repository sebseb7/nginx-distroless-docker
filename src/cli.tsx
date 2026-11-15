import React from 'react';
import { render } from 'ink';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { App, type CliCommand } from './components/App.js';

const VALID_COMMANDS = new Set<CliCommand>([
  'dashboard',
  'start',
  'stop',
  'restart',
  'test',
  'reload',
  'status',
  'logs',
  'install-hook',
  'cert',
]);

function printUsage(): void {
  console.log(
    [
      chalk.bold.cyan('Nginx Distroless CLI & TUI Manager'),
      '',
      `${chalk.bold('Usage:')} nginx-cli [command] [options]`,
      '',
      chalk.bold('Commands:'),
      `  ${chalk.green('(no args)')}          Launch interactive React Ink TUI dashboard`,
      `  ${chalk.green('start')}              Start readonly distroless Nginx container`,
      `  ${chalk.green('stop')}               Stop and remove the Nginx container`,
      `  ${chalk.green('restart')}            Restart the Nginx container`,
      `  ${chalk.green('test')}               Test Nginx configuration (nginx -t)`,
      `  ${chalk.green('reload')}             Test config and reload Nginx via SIGHUP`,
      `  ${chalk.green('status')}             Display running container status`,
      `  ${chalk.green('logs')}               Stream live access/error or container logs`,
      `  ${chalk.green('install-hook')}       Ensure Certbot renewal deploy hook is installed`,
      `  ${chalk.green('cert <domains...>')}  Request Let's Encrypt certificate via webroot`,
      '',
      chalk.bold('Environment Overrides:'),
      `  CONTAINER_NAME, IMAGE_NAME, NETWORK_MODE, HTTP_PORT, HTTPS_PORT,`,
      `  NGINX_CONF, NGINX_CONF_D, LOGS_DIR, LETSENCRYPT_DIR, SSL_CERTS_DIR, WWW_ROOT_DIR`,
    ].join('\n')
  );
}

const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0];

if (firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
  printUsage();
  process.exit(0);
}

const commandArg = (firstArg ?? 'dashboard') as CliCommand;

if (!VALID_COMMANDS.has(commandArg)) {
  console.error(
    chalk.red(
      `Unknown command: '${firstArg}'.\nUsage: nginx-cli {start|stop|restart|test|reload|status|logs|cert|install-hook}`
    )
  );
  process.exit(1);
}

if (commandArg === 'cert' && rawArgs.slice(1).length === 0) {
  console.error(chalk.red('Usage: nginx-cli cert <domain> [additional-domains...]'));
  process.exit(1);
}

const config = loadConfig();

render(<App config={config} command={commandArg} args={rawArgs.slice(1)} />);

