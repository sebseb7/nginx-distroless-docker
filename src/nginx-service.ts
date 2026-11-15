import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import type { NginxConfig } from './config.js';

export type LogCallback = (line: string) => void;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ContainerStatusInfo {
  running: boolean;
  exists: boolean;
  statusText: string;
  rawTable: string;
}

function runCommand(
  cmd: string,
  args: string[],
  options: {
    onLog?: LogCallback;
    silent?: boolean;
    input?: string;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.silent && options.onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) {
            options.onLog(chalk.gray(`    ${line}`));
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.silent && options.onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) {
            options.onLog(chalk.yellow(`    ${line}`));
          }
        }
      }
    });

    child.on('error', (err) => {
      rejectPromise(err);
    });

    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

export function ensureDirs(config: NginxConfig, onLog?: LogCallback): void {
  for (const dir of [config.logsDir, config.letsencryptDir, config.nginxConfD]) {
    mkdirSync(dir, { recursive: true });
  }
  onLog?.(
    chalk.dim(
      `[*] Ensured host directories (${config.logsDir}, ${config.letsencryptDir}, ${config.nginxConfD})`
    )
  );
}

export async function ensureCertbotHook(
  config: NginxConfig,
  onLog?: LogCallback
): Promise<void> {
  const hookDir = `${config.sslCertsDir}/renewal-hooks/deploy`;
  const hookFile = `${hookDir}/reload-nginx.sh`;

  let sslDirExists = existsSync(config.sslCertsDir);
  if (!sslDirExists) {
    const checkDir = await runCommand('sudo', ['test', '-d', config.sslCertsDir], {
      silent: true,
    });
    sslDirExists = checkDir.code === 0;
  }

  if (!sslDirExists) {
    onLog?.(
      chalk.dim(
        `[*] SSL certs directory (${config.sslCertsDir}) not present on host; skipping Certbot hook.`
      )
    );
    return;
  }

  const checkExecutable = await runCommand('sudo', ['test', '-x', hookFile], {
    silent: true,
  });

  if (checkExecutable.code !== 0) {
    onLog?.(
      chalk.cyan(`[*] Installing Certbot deploy hook at ${chalk.bold(hookFile)}...`)
    );
    const mkdirRes = await runCommand('sudo', ['mkdir', '-p', hookDir], {
      onLog,
    });
    if (mkdirRes.code !== 0) {
      throw new Error(`Failed to create directory ${hookDir}`);
    }

    const hookContent = `#!/usr/bin/env bash\nset -euo pipefail\n"${config.baseDir}/run.sh" reload\n`;
    const teeRes = await runCommand('sudo', ['tee', hookFile], {
      silent: true,
      input: hookContent,
    });
    if (teeRes.code !== 0) {
      throw new Error(`Failed to write Certbot deploy hook to ${hookFile}`);
    }

    const chmodRes = await runCommand('sudo', ['chmod', '+x', hookFile], {
      onLog,
    });
    if (chmodRes.code !== 0) {
      throw new Error(`Failed to chmod +x ${hookFile}`);
    }

    onLog?.(chalk.green('[+] Certbot deploy hook installed.'));
  } else {
    onLog?.(chalk.green(`[+] Certbot deploy hook already installed at ${hookFile}.`));
  }
}

export async function getContainerStatus(
  config: NginxConfig
): Promise<ContainerStatusInfo> {
  const allRes = await runCommand(
    'docker',
    ['ps', '-a', '--filter', `name=^${config.containerName}$`, '--format', '{{.Names}}\t{{.Status}}'],
    { silent: true }
  );

  const lines = allRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const match = lines.find((l) => l.split('\t')[0] === config.containerName);
  const exists = Boolean(match);
  const statusText = match ? match.split('\t')[1] ?? 'Unknown' : 'Not created';
  const running = exists && /^Up\b/i.test(statusText);

  const tableRes = await runCommand(
    'docker',
    ['ps', '-f', `name=^${config.containerName}$`],
    { silent: true }
  );

  return {
    running,
    exists,
    statusText,
    rawTable: tableRes.stdout,
  };
}

export async function startContainer(
  config: NginxConfig,
  onLog?: LogCallback
): Promise<void> {
  ensureDirs(config, onLog);
  await ensureCertbotHook(config, onLog);

  const status = await getContainerStatus(config);
  if (status.exists) {
    onLog?.(
      chalk.yellow(
        `[!] Container '${chalk.bold(config.containerName)}' already exists. Stopping and removing...`
      )
    );
    await runCommand('docker', ['stop', config.containerName], { silent: true });
    await runCommand('docker', ['rm', config.containerName], { silent: true });
  }

  onLog?.(
    chalk.cyan(
      `[*] Starting readonly distroless Nginx container '${chalk.bold(config.containerName)}'...`
    )
  );

  const dockerArgs: string[] = [
    'run',
    '-d',
    '--name',
    config.containerName,
    '--restart',
    'always',
    '--read-only',
    '--stop-signal',
    'SIGQUIT',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=64m',
    '--tmpfs',
    '/usr/local/nginx/client_body_temp:rw,uid=1000,gid=1000,mode=0700,size=256m',
    '--tmpfs',
    '/usr/local/nginx/proxy_temp:rw,uid=1000,gid=1000,mode=0700,size=256m',
    '-v',
    `${config.logsDir}:/usr/local/nginx/logs`,
    '-v',
    `${config.nginxConf}:/usr/local/nginx/conf/nginx.conf:ro`,
    '-v',
    `${config.nginxConfD}:/home/ubuntu/nginx.conf.d:ro`,
    '-v',
    `${config.letsencryptDir}:/home/ubuntu/letsencrypt:ro`,
  ];

  if (existsSync(config.sslCertsDir)) {
    dockerArgs.push('-v', `${config.sslCertsDir}:/etc/letsencrypt:ro`);
  }

  if (existsSync(config.wwwRootDir)) {
    dockerArgs.push('-v', `${config.wwwRootDir}:/home/ubuntu/src:ro`);
  }

  if (config.networkMode === 'host') {
    dockerArgs.push('--net=host');
  } else {
    dockerArgs.push(
      '-p',
      `${config.httpPort}:80`,
      '-p',
      `${config.httpsPort}:443`
    );
  }

  dockerArgs.push(config.imageName);

  const res = await runCommand('docker', dockerArgs, { onLog });
  if (res.code !== 0) {
    throw new Error(
      `Failed to start container '${config.containerName}' (exit code ${res.code}): ${res.stderr || res.stdout}`
    );
  }

  onLog?.(
    chalk.green(
      `[+] Nginx container '${chalk.bold(config.containerName)}' started successfully.`
    )
  );
  onLog?.(chalk.white(`    - Logs directory: ${chalk.underline(config.logsDir)}`));
  onLog?.(chalk.white(`    - Config file:    ${chalk.underline(config.nginxConf)}`));
}

export async function testConfig(
  config: NginxConfig,
  onLog?: LogCallback
): Promise<void> {
  const status = await getContainerStatus(config);

  if (status.running) {
    onLog?.(
      chalk.cyan(
        `[*] Testing configuration on running container '${chalk.bold(config.containerName)}'...`
      )
    );
    const res = await runCommand(
      'docker',
      ['exec', config.containerName, '/usr/local/nginx/sbin/nginx', '-t'],
      { onLog }
    );
    if (res.code !== 0) {
      throw new Error(`Configuration test failed (exit code ${res.code})`);
    }
    onLog?.(chalk.green('[+] Configuration test passed.'));
  } else {
    onLog?.(
      chalk.cyan(
        '[*] Container not running. Testing configuration in ephemeral container...'
      )
    );
    ensureDirs(config, onLog);

    const testArgs: string[] = [
      'run',
      '--rm',
      '-v',
      `${config.nginxConf}:/usr/local/nginx/conf/nginx.conf:ro`,
      '-v',
      `${config.nginxConfD}:/home/ubuntu/nginx.conf.d:ro`,
      '-v',
      `${config.letsencryptDir}:/home/ubuntu/letsencrypt:ro`,
    ];

    if (existsSync(config.sslCertsDir)) {
      testArgs.push('-v', `${config.sslCertsDir}:/etc/letsencrypt:ro`);
    }

    if (existsSync(config.wwwRootDir)) {
      testArgs.push('-v', `${config.wwwRootDir}:/home/ubuntu/src:ro`);
    }

    testArgs.push(config.imageName, '-t');

    const res = await runCommand('docker', testArgs, { onLog });
    if (res.code !== 0) {
      throw new Error(`Ephemeral configuration test failed (exit code ${res.code})`);
    }
    onLog?.(chalk.green('[+] Configuration test passed.'));
  }
}

export async function reloadNginx(
  config: NginxConfig,
  onLog?: LogCallback
): Promise<void> {
  onLog?.(chalk.cyan('[*] Testing configuration before reload...'));
  await testConfig(config, onLog);

  onLog?.(chalk.cyan('[*] Reloading Nginx configuration via SIGHUP...'));
  const res = await runCommand(
    'docker',
    ['kill', '--signal=HUP', config.containerName],
    { onLog }
  );
  if (res.code !== 0) {
    throw new Error(
      `Failed to send SIGHUP to '${config.containerName}' (exit code ${res.code})`
    );
  }
  onLog?.(chalk.green('[+] Configuration reloaded.'));
}

export async function stopContainer(
  config: NginxConfig,
  onLog?: LogCallback
): Promise<void> {
  onLog?.(
    chalk.cyan(`[*] Stopping container '${chalk.bold(config.containerName)}'...`)
  );
  const stopRes = await runCommand('docker', ['stop', config.containerName], {
    onLog,
  });
  if (stopRes.code !== 0) {
    throw new Error(
      `Failed to stop container '${config.containerName}' (exit code ${stopRes.code})`
    );
  }

  const rmRes = await runCommand('docker', ['rm', config.containerName], {
    onLog,
  });
  if (rmRes.code !== 0) {
    throw new Error(
      `Failed to remove container '${config.containerName}' (exit code ${rmRes.code})`
    );
  }

  onLog?.(
    chalk.green(
      `[+] Container '${chalk.bold(config.containerName)}' stopped and removed.`
    )
  );
}

export async function restartContainer(
  config: NginxConfig,
  onLog?: LogCallback
): Promise<void> {
  try {
    await stopContainer(config, onLog);
  } catch {
    onLog?.(
      chalk.yellow(
        `[!] Container '${config.containerName}' was not running; proceeding with start.`
      )
    );
  }
  await startContainer(config, onLog);
}

export async function statusContainer(
  config: NginxConfig,
  onLog?: LogCallback
): Promise<ContainerStatusInfo> {
  const info = await getContainerStatus(config);
  for (const line of info.rawTable.split(/\r?\n/)) {
    if (line.trim()) {
      onLog?.(chalk.white(line));
    }
  }
  return info;
}

export async function acquireCert(
  config: NginxConfig,
  domains: string[],
  onLog?: LogCallback
): Promise<void> {
  const cleanDomains = domains.map((d) => d.trim()).filter(Boolean);
  if (cleanDomains.length === 0) {
    throw new Error('Usage: cert <domain> [additional-domains...]');
  }

  ensureDirs(config, onLog);
  await ensureCertbotHook(config, onLog);

  const domainArgs: string[] = [];
  for (const d of cleanDomains) {
    domainArgs.push('-d', d);
  }

  onLog?.(
    chalk.cyan(
      `[*] Requesting Let's Encrypt certificate for: ${chalk.bold(cleanDomains.join(', '))}`
    )
  );

  const res = await runCommand(
    'sudo',
    [
      'certbot',
      'certonly',
      '--webroot',
      '-w',
      config.letsencryptDir,
      ...domainArgs,
    ],
    { onLog }
  );

  if (res.code !== 0) {
    throw new Error(`Certbot failed with exit code ${res.code}`);
  }

  onLog?.(
    chalk.green(
      `[+] Certificate request completed for: ${cleanDomains.join(', ')}`
    )
  );
}

export function streamLogs(
  config: NginxConfig,
  onLine: LogCallback
): () => void {
  const accessLog = resolve(config.logsDir, 'access.log');
  const errorLog = resolve(config.logsDir, 'error.log');
  const hasHostLogs = existsSync(accessLog) || existsSync(errorLog);

  const cmd = hasHostLogs ? 'tail' : 'docker';
  const args = hasHostLogs
    ? ['-n', '25', '-f', accessLog, errorLog]
    : ['logs', '--tail', '25', '-f', config.containerName];

  onLine(
    chalk.cyan(
      `[*] Streaming logs via: ${chalk.bold(`${cmd} ${args.join(' ')}`)} (Press Esc or q to stop)`
    )
  );

  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const handleChunk = (isErr: boolean) => (chunk: Buffer) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length > 0) {
        onLine(isErr ? chalk.yellow(line) : chalk.white(line));
      }
    }
  };

  child.stdout.on('data', handleChunk(false));
  child.stderr.on('data', handleChunk(true));

  return () => {
    child.kill('SIGTERM');
  };
}

