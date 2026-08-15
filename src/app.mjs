#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib/job.mjs';
import { listenPrimerDesignApp } from './web-app.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(process.env.PRIME_DESIGN_APP_ROOT || sourceRoot);
const dataRoot = path.resolve(process.env.PRIME_DESIGN_DATA_ROOT || sourceRoot);
const dataConfigPath = path.join(dataRoot, 'config', 'default.json');
const defaultConfigPath = existsSync(dataConfigPath)
  ? dataConfigPath
  : path.join(appRoot, 'config', 'default.json');
const requestedPort = Number(process.env.PRIME_DESIGN_PORT || 43110);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error('PRIME_DESIGN_PORT 必须是 0–65535 的整数。');
}

const app = await listenPrimerDesignApp({
  appRoot,
  dataRoot,
  port: requestedPort,
  loadConfig: async (configPath = defaultConfigPath) => {
    const config = await readJson(path.resolve(configPath || defaultConfigPath));
    if (config.schemaVersion !== 1) throw new Error(`不支持的配置 schemaVersion：${config.schemaVersion}`);
    return config;
  },
});

console.log(`批量引物设计软件已启动：${app.url}`);
console.log('前台调试模式可按 Ctrl+C 停止；双击启动脚本时服务会在后台运行。');

if (process.argv.includes('--open')) {
  const child = spawn('cmd.exe', ['/c', 'start', '', app.url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (app.server.listening) app.server.close(() => process.exit(0));
    else process.exit(0);
  });
}
