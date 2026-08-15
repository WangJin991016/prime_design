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
  const source = await readFile(path.join(projectRoot, 'scripts', 'server', 'run-ispcr.slurm'), 'utf8');
  assert.match(source, /blat-review-ids\.txt/);
  assert.match(source, /total\[id\] != 1 \|\| primary\[id\] != 1/);
  assert.match(source, /skipped_all_unique_primary/);
  assert.match(source, /reviewed_suspicious_only/);
  assert.match(source, /blatReviewMode\\tsuspicious_only_v1/);
});
