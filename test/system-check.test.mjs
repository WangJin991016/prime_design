import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocalSystem, checkRemoteSystem } from '../src/lib/system-check.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local system check reports A-drive, OpenSSH and 16 CPU/64 GB Slurm scripts', async () => {
  const runner = async (command, args) => {
    assert.equal(command, 'where.exe');
    assert.ok(['ssh.exe', 'scp.exe'].includes(args[0]));
    return { stdout: `C:\\Windows\\System32\\OpenSSH\\${args[0]}\n`, stderr: '' };
  };
  const result = await checkLocalSystem({
    appRoot: projectRoot, dataRoot: projectRoot, runner,
    config: { primer3: { server: { sshConfigPath: path.join(projectRoot, 'package.json') } } },
  });
  assert.equal(result.dataOnADrive, true);
  assert.equal(result.dataWritable, true);
  assert.equal(result.sshAvailable, true);
  assert.equal(result.scpAvailable, true);
  assert.equal(result.sshConfigReadable, true);
  assert.equal(result.slurm.verified, true);
  assert.equal(result.slurm.requestedCpus, 16);
  assert.equal(result.slurm.requestedMemoryGiB, 64);
  assert.equal(result.ready, true);
});

test('remote system check returns only status metadata and validates all tools and genomes', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (args.at(-2) === 'sbatch' && args.at(-1) === '--version') return { stdout: 'slurm 23.02.7\n', stderr: '' };
    if (args.includes('sha256sum')) return { stdout: `${'e'.repeat(64)}  run-ispcr.slurm\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const server = {
    hostAlias: 'Fdu_imi', sshConfigPath: 'C:\\Users\\Jensen\\.ssh\\config',
    remoteRoot: '/home/u22111510029/workspace/Codex_workspace/prime_design',
    slurmScript: '/home/u22111510029/workspace/Codex_workspace/prime_design/jobs/run-ispcr.slurm',
    expectedRunScriptSha256: 'e'.repeat(64),
    expectedToolSha256: 'e'.repeat(64), expectedIsPcrSha256: 'e'.repeat(64),
    expectedBlatSha256: 'e'.repeat(64), expectedDatabaseSha256: {
      hs1: 'e'.repeat(64), hg38: 'e'.repeat(64), mm10: 'e'.repeat(64),
    },
    expectedProvisionManifestSha256: 'e'.repeat(64),
    expectedVersion: '2.6.1', expectedIsPcrVersion: 'v385', expectedBlatVersion: 'v385',
  };
  const result = await checkRemoteSystem({
    config: { primer3: { server }, ucsc: { isPcrServer: server } }, runner,
  });
  assert.equal(result.ready, true);
  assert.equal(result.slurmVersion, 'slurm 23.02.7');
  assert.deepEqual(result.tools, { primer3: true, isPcr: true, blat: true });
  assert.deepEqual(result.toolVersions, { primer3: '2.6.1', isPcr: 'v385', blat: 'v385' });
  assert.equal(result.provisionManifest, true);
  assert.equal(result.runScript, true);
  assert.equal(result.runScriptSyntax, true);
  assert.equal(result.runScriptSelfTest, true);
  assert.deepEqual(result.assemblies, { hs1: true, hg38: true, mm10: true });
  assert.equal(JSON.stringify(result).includes('remoteRoot'), false);
  assert.equal(JSON.stringify(result).includes('.ssh'), false);
  assert.equal(calls.length, 11);
});

test('remote system check fails closed when the deployed validation script self-test fails', async () => {
  const runner = async (command, args) => {
    if (args.at(-2) === 'sbatch' && args.at(-1) === '--version') return { stdout: 'slurm 23.02.7\n', stderr: '' };
    if (args.includes('sha256sum')) return { stdout: `${'e'.repeat(64)}  run-ispcr.slurm\n`, stderr: '' };
    if (args.at(-1) === '--self-test') throw new Error('self-test failed');
    return { stdout: '', stderr: '' };
  };
  const server = {
    hostAlias: 'Fdu_imi', remoteRoot: '/home/user/prime_design',
    slurmScript: '/home/user/prime_design/jobs/run-ispcr-parallel-v2.slurm',
    expectedRunScriptSha256: 'e'.repeat(64), expectedProvisionManifestSha256: 'e'.repeat(64),
    expectedVersion: '2.6.1', expectedIsPcrVersion: 'v385', expectedBlatVersion: 'v385',
  };
  const result = await checkRemoteSystem({
    config: { primer3: { server }, ucsc: { isPcrServer: server } }, runner,
  });
  assert.equal(result.runScript, true);
  assert.equal(result.runScriptSyntax, true);
  assert.equal(result.runScriptSelfTest, false);
  assert.equal(result.ready, false);
});
