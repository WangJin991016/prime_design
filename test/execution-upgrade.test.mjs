import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROKEN_ISPCR_RUN_SCRIPT_SHA256,
  upgradeKnownBrokenIsPcrExecution,
} from '../src/batch-cli.mjs';
import { moveDirectoryToRecycleBin } from '../src/lib/recycle-bin.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('execution hotfix archives the failed snapshot and upgrades only the known broken runner hash', async () => {
  const root = path.join(projectRoot, 'runs', `test-execution-upgrade-${randomUUID()}`);
  const resumeRoot = path.join(root, 'raw', 'server-ispcr');
  const fixedHash = 'f'.repeat(64);
  const server = {
    hostAlias: 'Fdu_imi', remoteRoot: '/safe/root',
    slurmScript: '/safe/root/jobs/run-ispcr-parallel-v2.slurm',
    progressProtocol: 'parallel_v1', expectedRunScriptSha256: BROKEN_ISPCR_RUN_SCRIPT_SHA256,
  };
  const originalBatch = {
    batchId: 'test-batch', status: 'retryable_error', updatedAt: '2026-08-19T01:05:00Z',
    run: { jobId: '2349884', runId: 'failed-run' },
  };
  const originalConfig = {
    schemaVersion: 1, primer3: { parameters: { numReturn: 5 } },
    ucsc: { maxProductSize: 10000, parallelism: 4, isPcrServer: server },
  };
  const resume = { signature: 'old', slurmJobId: '2349884', runId: 'failed-run' };
  await mkdir(resumeRoot, { recursive: true });
  await writeFile(path.join(root, 'batch.json'), `${JSON.stringify(originalBatch)}\n`, 'utf8');
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify(originalConfig)}\n`, 'utf8');
  await writeFile(path.join(resumeRoot, 'resume-test-batch-mm10.json'), `${JSON.stringify(resume)}\n`, 'utf8');
  try {
    const upgraded = await upgradeKnownBrokenIsPcrExecution(root, {
      ucsc: { isPcrServer: { ...server, expectedRunScriptSha256: fixedHash } },
    }, new Date('2026-08-19T02:00:00Z'));
    assert.ok(upgraded);
    const updatedConfig = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
    const updatedBatch = JSON.parse(await readFile(path.join(root, 'batch.json'), 'utf8'));
    assert.equal(updatedConfig.ucsc.isPcrServer.expectedRunScriptSha256, fixedHash);
    assert.equal(updatedConfig.ucsc.maxProductSize, 10000);
    assert.equal(updatedConfig.ucsc.parallelism, 4);
    assert.equal(updatedConfig.primer3.parameters.numReturn, 5);
    assert.equal(updatedBatch.executionUpgrades.length, 1);
    assert.equal(updatedBatch.executionUpgrades[0].failedJobId, '2349884');
    assert.equal((await stat(path.join(upgraded.auditDir, 'config.json'))).isFile(), true);
    assert.equal((await stat(path.join(upgraded.auditDir, 'batch.json'))).isFile(), true);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(upgraded.auditDir, 'resume-test-batch-mm10.json'), 'utf8')),
      resume,
    );
    assert.equal(await upgradeKnownBrokenIsPcrExecution(root, {
      ucsc: { isPcrServer: { ...server, expectedRunScriptSha256: fixedHash } },
    }), null);
  } finally {
    await moveDirectoryToRecycleBin({ targetPath: root, appRoot: projectRoot });
  }
});
