import { constants } from 'node:fs';
import { access, readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './ispcr.mjs';

const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_HOST_ALIAS = /^[A-Za-z0-9._-]+$/;
const REQUIRED_ASSEMBLIES = Object.freeze(['hs1', 'hg38', 'mm10']);

async function commandAvailable(command, runner) {
  try {
    await runner('where.exe', [command], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function safeRemoteRoot(value) {
  const root = String(value || '').replace(/\/$/, '');
  if (!SAFE_REMOTE_PATH.test(root) || root.split('/').includes('..')) {
    throw new Error('服务器工作目录配置无效。');
  }
  return root;
}

function safeHostAlias(value) {
  const host = String(value || '');
  if (!SAFE_HOST_ALIAS.test(host)) throw new Error('SSH 主机别名配置无效。');
  return host;
}

function sshArgs(server) {
  const args = [];
  if (server.sshConfigPath) args.push('-F', String(server.sshConfigPath));
  args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10');
  return args;
}

async function readSlurmResources(appRoot) {
  const names = ['run-primer3.slurm', 'run-ispcr-parallel-v2.slurm'];
  const entries = [];
  for (const name of names) {
    const filePath = path.join(appRoot, 'scripts', 'server', name);
    try {
      const source = await readFile(filePath, 'utf8');
      entries.push({
        name,
        cpus: Number(source.match(/^#SBATCH --cpus-per-task=(\d+)$/m)?.[1] || 0),
        memoryGiB: Number(source.match(/^#SBATCH --mem=(\d+)G$/m)?.[1] || 0),
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const verified = entries.length === names.length
    && entries.every((entry) => entry.cpus === 16 && entry.memoryGiB === 64);
  return { requestedCpus: 16, requestedMemoryGiB: 64, verified, scripts: entries };
}

export async function checkLocalSystem({ appRoot, dataRoot, config = {}, runner = runProcess }) {
  const resolvedData = path.resolve(dataRoot);
  const drive = path.parse(resolvedData).root.toUpperCase();
  let dataWritable = false;
  try { await access(resolvedData, constants.R_OK | constants.W_OK); dataWritable = true; } catch {}
  let disk = null;
  try {
    const info = await statfs(resolvedData, { bigint: true });
    disk = {
      freeBytes: Number(info.bavail * info.bsize),
      totalBytes: Number(info.blocks * info.bsize),
    };
  } catch {}
  const sshConfigPath = config?.primer3?.server?.sshConfigPath || config?.ucsc?.isPcrServer?.sshConfigPath;
  const [sshAvailable, scpAvailable, sshConfigReadable, packageText, slurm] = await Promise.all([
    commandAvailable('ssh.exe', runner),
    commandAvailable('scp.exe', runner),
    sshConfigPath ? access(sshConfigPath, constants.R_OK).then(() => true, () => false) : Promise.resolve(false),
    readFile(path.join(appRoot, 'package.json'), 'utf8').catch(() => '{}'),
    readSlurmResources(appRoot),
  ]);
  let version = 'unknown';
  try { version = JSON.parse(packageText).version || version; } catch {}
  return {
    checkedAt: new Date().toISOString(),
    version,
    dataDrive: drive,
    dataOnADrive: drive === 'A:\\',
    dataWritable,
    disk,
    sshAvailable,
    scpAvailable,
    sshConfigReadable,
    slurm,
    ready: drive === 'A:\\' && dataWritable && sshAvailable && scpAvailable && sshConfigReadable && slurm.verified,
  };
}

async function remoteHashMatches({ runner, connection, host, filePath, expected }) {
  if (!/^[a-f0-9]{64}$/i.test(String(expected || ''))) return false;
  try {
    const result = await runner('ssh', [...connection, host, 'sha256sum', filePath], { timeoutMs: 20_000 });
    return String(result.stdout || '').trim().split(/\s+/)[0]?.toLowerCase() === String(expected).toLowerCase();
  } catch { return false; }
}

async function remoteTest({ runner, connection, host, testArgs }) {
  try {
    await runner('ssh', [...connection, host, 'test', ...testArgs], { timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export async function checkRemoteSystem({ config, runner = runProcess }) {
  const primer3Server = config?.primer3?.server || {};
  const validationServer = config?.ucsc?.isPcrServer || {};
  const host = safeHostAlias(primer3Server.hostAlias || validationServer.hostAlias);
  if (validationServer.hostAlias && validationServer.hostAlias !== host) {
    throw new Error('Primer3 与 UCSC 验证配置使用了不同 SSH 主机。');
  }
  const root = safeRemoteRoot(validationServer.remoteRoot || primer3Server.remoteRoot);
  const connection = sshArgs({ ...validationServer, sshConfigPath: validationServer.sshConfigPath || primer3Server.sshConfigPath });
  let slurmVersion = '';
  try {
    const result = await runner('ssh', [...connection, host, 'sbatch', '--version'], { timeoutMs: 20_000 });
    slurmVersion = String(result.stdout || '').trim().slice(0, 160);
  } catch {}
  const checks = await Promise.all([
    remoteTest({ runner, connection, host, testArgs: ['-x', `${root}/tools/primer3-2.6.1/primer3_core`] }),
    remoteTest({ runner, connection, host, testArgs: ['-x', `${root}/bin/isPcr-v385`] }),
    remoteTest({ runner, connection, host, testArgs: ['-x', `${root}/bin/blat-v385-bin`] }),
    ...REQUIRED_ASSEMBLIES.map((assembly) => remoteTest({
      runner, connection, host, testArgs: ['-s', `${root}/genomes/${assembly}.2bit`],
    })),
    remoteHashMatches({
      runner, connection, host, filePath: `${root}/provision-manifest.tsv`,
      expected: validationServer.expectedProvisionManifestSha256,
    }),
    remoteHashMatches({
      runner, connection, host, filePath: validationServer.slurmScript,
      expected: validationServer.expectedRunScriptSha256,
    }),
  ]);
  const [primer3, isPcr, blat, ...tail] = checks;
  const assemblies = tail.slice(0, REQUIRED_ASSEMBLIES.length);
  const provisionManifest = tail.at(-2);
  const runScript = tail.at(-1);
  const assemblyStatus = Object.fromEntries(REQUIRED_ASSEMBLIES.map((assembly, index) => [assembly, assemblies[index]]));
  return {
    checkedAt: new Date().toISOString(),
    connected: Boolean(slurmVersion),
    slurmVersion,
    tools: { primer3, isPcr, blat },
    toolVersions: {
      primer3: String(primer3Server.expectedVersion || 'unknown').slice(0, 64),
      isPcr: String(validationServer.expectedIsPcrVersion || 'unknown').slice(0, 64),
      blat: String(validationServer.expectedBlatVersion || 'unknown').slice(0, 64),
    },
    provisionManifest,
    runScript,
    assemblies: assemblyStatus,
    ready: Boolean(slurmVersion) && primer3 && isPcr && blat
      && provisionManifest && runScript && assemblies.every(Boolean),
  };
}

export { REQUIRED_ASSEMBLIES };
