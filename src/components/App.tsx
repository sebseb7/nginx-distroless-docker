import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import chalk from 'chalk';
import type { NginxConfig } from '../config.js';
import {
  acquireCert,
  ensureCertbotHook,
  getContainerStatus,
  reloadNginx,
  restartContainer,
  startContainer,
  statusContainer,
  stopContainer,
  streamLogs,
  testConfig,
  type ContainerStatusInfo,
} from '../nginx-service.js';

export type CliCommand =
  | 'dashboard'
  | 'start'
  | 'stop'
  | 'restart'
  | 'test'
  | 'reload'
  | 'status'
  | 'logs'
  | 'install-hook'
  | 'cert';

interface MenuItem {
  id: Exclude<CliCommand, 'dashboard'> | 'quit';
  label: string;
  hotkey: string;
  description: string;
}

const MENU_ITEMS: MenuItem[] = [
  {
    id: 'start',
    label: 'Start Container',
    hotkey: 's',
    description: 'Start readonly distroless Nginx container',
  },
  {
    id: 'stop',
    label: 'Stop Container',
    hotkey: 'x',
    description: 'Stop and remove the Nginx container',
  },
  {
    id: 'restart',
    label: 'Restart Container',
    hotkey: 'r',
    description: 'Stop (if running) and start a fresh container',
  },
  {
    id: 'test',
    label: 'Test Config (nginx -t)',
    hotkey: 't',
    description: 'Validate nginx.conf in running or ephemeral container',
  },
  {
    id: 'reload',
    label: 'Reload Config (SIGHUP)',
    hotkey: 'l',
    description: 'Test config and reload Nginx with zero downtime',
  },
  {
    id: 'status',
    label: 'Container Status',
    hotkey: 'u',
    description: 'Check running container status (docker ps)',
  },
  {
    id: 'logs',
    label: 'Stream Live Logs',
    hotkey: 'f',
    description: 'Tail access.log / error.log or container logs',
  },
  {
    id: 'install-hook',
    label: 'Install Certbot Hook',
    hotkey: 'h',
    description: 'Ensure renewal deploy hook is installed',
  },
  {
    id: 'cert',
    label: 'Acquire SSL Certificate',
    hotkey: 'c',
    description: 'Request Let’s Encrypt certificate via webroot',
  },
  {
    id: 'quit',
    label: 'Quit',
    hotkey: 'q',
    description: 'Exit Nginx Manager',
  },
];

export interface AppProps {
  config: NginxConfig;
  command: CliCommand;
  args: string[];
}

export const App: React.FC<AppProps> = ({ config, command, args }) => {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [promptingCert, setPromptingCert] = useState(false);
  const [certInput, setCertInput] = useState('');
  const [statusInfo, setStatusInfo] = useState<ContainerStatusInfo | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  const stopStreamRef = useRef<(() => void) | null>(null);

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-60), line]);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const info = await getContainerStatus(config);
      setStatusInfo(info);
    } catch {
      // ignore background status check failures
    }
  }, [config]);

  const executeAction = useCallback(
    async (action: Exclude<CliCommand, 'dashboard'>, actionArgs: string[] = []) => {
      if (action === 'logs') {
        setStreaming(true);
        stopStreamRef.current = streamLogs(config, appendLog);
        return;
      }

      setBusy(true);
      setCommandError(null);

      try {
        switch (action) {
          case 'start':
            await startContainer(config, appendLog);
            break;
          case 'stop':
            await stopContainer(config, appendLog);
            break;
          case 'restart':
            await restartContainer(config, appendLog);
            break;
          case 'test':
            await testConfig(config, appendLog);
            break;
          case 'reload':
            await reloadNginx(config, appendLog);
            break;
          case 'status':
            await statusContainer(config, appendLog);
            break;
          case 'install-hook':
            await ensureCertbotHook(config, appendLog);
            break;
          case 'cert':
            await acquireCert(config, actionArgs, appendLog);
            break;
        }
        await refreshStatus();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setCommandError(message);
        appendLog(chalk.red(`[-] Error: ${message}`));
        if (command !== 'dashboard') {
          process.exitCode = 1;
        }
      } finally {
        setBusy(false);
        if (command !== 'dashboard') {
          setTimeout(() => exit(), 50);
        }
      }
    },
    [appendLog, command, config, exit, refreshStatus]
  );

  // Initial execution for direct CLI subcommands or dashboard status load
  useEffect(() => {
    refreshStatus();
    if (command !== 'dashboard') {
      void executeAction(command, args);
    }
    return () => {
      if (stopStreamRef.current) {
        stopStreamRef.current();
      }
    };
  }, [args, command, executeAction, refreshStatus]);

  useInput(
    (input, key) => {
      // Stop log stream on Esc, q, or b
      if (streaming) {
        if (key.escape || input === 'q' || input === 'b') {
          if (stopStreamRef.current) {
            stopStreamRef.current();
            stopStreamRef.current = null;
          }
          setStreaming(false);
          appendLog(chalk.dim('[*] Stopped log streaming.'));
          if (command === 'logs') {
            exit();
          }
        }
        return;
      }

      if (command !== 'dashboard') {
        return;
      }

      // Cert domain text input mode
      if (promptingCert) {
        if (key.escape) {
          setPromptingCert(false);
          setCertInput('');
          appendLog(chalk.dim('[*] Cancelled SSL certificate prompt.'));
          return;
        }
        if (key.return) {
          const domains = certInput.split(/\s+/).filter(Boolean);
          setPromptingCert(false);
          setCertInput('');
          if (domains.length > 0) {
            void executeAction('cert', domains);
          } else {
            appendLog(chalk.yellow('[!] No domains entered.'));
          }
          return;
        }
        if (key.backspace || key.delete) {
          setCertInput((prev) => prev.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setCertInput((prev) => prev + input);
        }
        return;
      }

      if (busy) {
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => (prev - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => (prev + 1) % MENU_ITEMS.length);
        return;
      }

      if (key.return) {
        const chosen = MENU_ITEMS[selectedIndex];
        if (!chosen) return;
        if (chosen.id === 'quit') {
          exit();
          return;
        }
        if (chosen.id === 'cert') {
          setPromptingCert(true);
          setCertInput('');
          return;
        }
        void executeAction(chosen.id);
        return;
      }

      // Hotkeys
      const matched = MENU_ITEMS.find((item) => item.hotkey === input.toLowerCase());
      if (matched) {
        if (matched.id === 'quit') {
          exit();
          return;
        }
        if (matched.id === 'cert') {
          setPromptingCert(true);
          setCertInput('');
          return;
        }
        void executeAction(matched.id);
      }
    },
    { isActive: isRawModeSupported }
  );

  const statusBadge = statusInfo
    ? statusInfo.running
      ? chalk.bgGreen.black.bold(' RUNNING ')
      : statusInfo.exists
        ? chalk.bgYellow.black.bold(' STOPPED ')
        : chalk.bgGray.white.bold(' NOT CREATED ')
    : chalk.bgGray.white(' CHECKING... ');

  // Direct CLI command view
  if (command !== 'dashboard') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Text>
            {chalk.bold.cyan('NGINX DISTROLESS MANAGER')} {chalk.gray('•')}{' '}
            {chalk.bold.white(`Command: ${command}`)} {statusBadge}
          </Text>
          <Text>
            {chalk.dim(
              `Container: ${config.containerName} (${config.imageName}) | Net: ${config.networkMode}`
            )}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1} paddingX={1}>
          {logs.map((line, idx) => (
            <Text key={idx}>{line}</Text>
          ))}
          {busy && (
            <Text>{chalk.cyan(`⏳ Executing '${command}'...`)}</Text>
          )}
          {commandError && (
            <Text>{chalk.red.bold(`✖ Command failed: ${commandError}`)}</Text>
          )}
        </Box>
      </Box>
    );
  }

  // Interactive Dashboard TUI view
  return (
    <Box flexDirection="column" padding={0}>
      {/* Header Banner */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={0}
        flexDirection="column"
      >
        <Box marginTop={0} flexDirection="column">
          <Text>
            {chalk.bold('Container:')} {chalk.green(config.containerName)}  {chalk.gray('|')}{' '}
            {chalk.bold('Image:')} {chalk.cyan(config.imageName)}  {chalk.gray('|')}{' '}
            {chalk.bold('Network:')} {chalk.magenta(config.networkMode)}{' '}
            {config.networkMode !== 'host'
              ? chalk.dim(`(${config.httpPort}->80, ${config.httpsPort}->443)`)
              : ''}
          </Text>
          <Text>
            {chalk.bold('Config:')} {chalk.underline(config.nginxConf)}  {chalk.gray('|')}{' '}
            {chalk.bold('Logs:')} {chalk.underline(config.logsDir)}
          </Text>
        </Box>
      </Box>

      {/* Main Content Split: Menu + Output Panel */}
      <Box marginTop={1} flexDirection="row" gap={2}>
        {/* Left Navigation Menu */}
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={promptingCert || streaming ? 'gray' : 'blue'}
          paddingX={2}
          paddingY={1}
          width={42}
        >
          <Text>{chalk.bold.blue('Actions (↑/↓/Enter or Hotkey)')}</Text>
          <Box marginTop={1} flexDirection="column">
            {MENU_ITEMS.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const prefix = isSelected ? chalk.cyan.bold('❯ ') : '  ';
              const keyTag = chalk.yellow(`[${item.hotkey}]`);
              const label = isSelected
                ? chalk.bold.white(item.label)
                : chalk.gray(item.label);
              return (
                <Text key={item.id}>
                  {prefix}
                  {keyTag} {label}
                </Text>
              );
            })}
          </Box>
          <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
            <Text>
              {chalk.dim(MENU_ITEMS[selectedIndex]?.description ?? '')}
            </Text>
          </Box>
        </Box>

        {/* Right Activity & Log Output */}
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={streaming ? 'green' : promptingCert ? 'yellow' : 'gray'}
          paddingX={2}
          paddingY={1}
          flexGrow={1}
        >
          <Box justifyContent="space-between">
            <Text>
              {chalk.bold.white('Output & Activity Log')}{' '}
              {busy ? chalk.yellow('(Running...)') : ''}{' '}
              {streaming ? chalk.green('(Streaming - press Esc/q to stop)') : ''}
            </Text>
          </Box>

          {promptingCert && (
            <Box
              marginTop={1}
              borderStyle="round"
              borderColor="yellow"
              paddingX={1}
              flexDirection="column"
            >
              <Text>
                {chalk.yellow.bold('Enter domain(s) separated by space (Enter to confirm, Esc to cancel):')}
              </Text>
              <Text>
                {chalk.cyan('> ')}
                {chalk.white.bold(certInput)}
                {chalk.inverse(' ')}
              </Text>
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            {logs.length === 0 ? (
              <Text>
                {chalk.dim('Select an action from the menu to manage the Nginx container.')}
              </Text>
            ) : (
              logs.slice(-18).map((line, i) => <Text key={i}>{line}</Text>)
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

