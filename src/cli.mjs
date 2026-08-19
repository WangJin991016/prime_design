#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib/job.mjs';
import { handleBatchCommand } from './batch-cli.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultConfigPath = path.join(projectRoot, 'config', 'default.json');

function parseArgs(argv) {
  const [command = 'help', ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith('--')) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

async function loadConfig(configPath = defaultConfigPath) {
  const config = await readJson(path.resolve(configPath));
  if (config.schemaVersion !== 1) {
    throw new Error(`不支持的配置 schemaVersion：${config.schemaVersion}`);
  }
  return config;
}

function printHelp() {
  console.log(`prime-design 0.5.4

批量命令：
  batch-prepare --fasta <multi.fasta> --manifest <batch.tsv> [--name 名称] [--out A:\\...]
  batch-design-primer3 --batch <批次目录>
  batch-validate-server --batch <批次目录>
  batch-revalidate --batch <批次目录> --max-product-size <1000-50000> [--parallelism <4-8>]
  batch-run --batch <批次目录>
  batch-report --batch <批次目录>
  provision-primer3-server [--config <配置文件>]

日常使用请双击 PrimerDesign.exe，或运行 npm run app 打开本地网页。`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  const handled = await handleBatchCommand(command, options, {
    projectRoot,
    defaultConfigPath,
    loadConfig,
  });
  if (!handled) throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
