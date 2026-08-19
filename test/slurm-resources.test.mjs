import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = [
  'provision-primer3.slurm',
  'provision-ucsc.slurm',
  'run-primer3.slurm',
  'run-ispcr.slurm',
  'run-ispcr-parallel-v2.slurm',
];

test('all Slurm jobs request 16 CPUs and 64 GB of memory', async () => {
  for (const name of scripts) {
    const source = await readFile(path.join(projectRoot, 'scripts', 'server', name), 'utf8');
    assert.match(source, /^#SBATCH --cpus-per-task=16$/m, name);
    assert.match(source, /^#SBATCH --mem=64G$/m, name);
  }
});

test('Primer3 provisioning uses the allocated CPU count', async () => {
  const source = await readFile(
    path.join(projectRoot, 'scripts', 'server', 'provision-primer3.slurm'),
    'utf8',
  );
  assert.match(source, /SLURM_CPUS_PER_TASK:-16/);
});

test('isPCR runs single-primer BLAT only for candidates needing review', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'server', 'run-ispcr-parallel-v2.slurm'), 'utf8');
  assert.match(source, /blat-review-ids\.txt/);
  assert.match(source, /total\[id\]!=1 \|\| primary\[id\]!=1/);
  assert.match(source, /skipped_all_unique_primary/);
  assert.match(source, /reviewed_suspicious_only/);
  assert.match(source, /blatReviewMode\\tsuspicious_only_v1/);
  assert.match(source, /\(\(NR-1\)%total\)==shard/);
  assert.match(source, /progress\.tsv/);
  assert.match(source, /--status/);
  assert.match(source, /--self-test/);
  assert.match(source, /--validate-stdin/);
  assert.match(source, /query_validation_failed/);
  assert.match(source, /integrity_check_failed/);
  assert.match(source, /shard_failed/);
  assert.doesNotMatch(source, /\*\$\/\s*\n\s*\|\| \$2 !~/);
  assert.match(source, /failed-\$shard/);
  assert.match(source, /exited without a completion marker/);
  assert.match(source, /terminate_shards/);
  assert.match(source, /shardManifestSha256/);
  assert.doesNotMatch(source, /wait -n/);
});
