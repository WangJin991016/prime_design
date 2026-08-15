import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ISPCR_WEB_PARAMETERS,
  ISPCR_WEB_CONSTRAINTS,
  buildBlatPrimerFasta,
  buildIsPcrQuery,
  buildSbatchRemoteArgs,
  makeRemoteRunId,
  parseBlatPsl,
  parseIsPcrBed,
  parseKeyValueTsv,
  parseResultManifest,
  normalizeIsPcrWebParameters,
  resultMatchesIsPcrParameters,
  validateIsPcrServerConfig,
  waitForSlurmCompletion,
} from '../src/lib/ispcr.mjs';

test('Slurm polling exposes job progress and fails closed on terminal errors', async () => {
  const states = ['PENDING', 'RUNNING', ''];
  const progress = [];
  const runner = async (_command, args) => {
    if (args.includes('squeue')) return { stdout: `${states.shift()}\n`, stderr: '' };
    if (args.includes('sacct')) return { stdout: 'COMPLETED|\n', stderr: '' };
    throw new Error('unexpected command');
  };
  const completed = await waitForSlurmCompletion({
    runner, connection: [], hostAlias: 'server', jobId: '123', timeoutMs: 1000,
    pollMs: 0, onProgress: async (value) => progress.push(value.state),
  });
  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(progress, ['PENDING', 'RUNNING', 'COMPLETED']);
  await assert.rejects(() => waitForSlurmCompletion({
    runner: async (_command, args) => args.includes('squeue')
      ? { stdout: '', stderr: '' } : { stdout: 'OUT_OF_MEMORY|\n', stderr: '' },
    connection: [], hostAlias: 'server', jobId: '124', timeoutMs: 1000, pollMs: 0,
  }), /OUT_OF_MEMORY/);
});

test('web isPCR validation defaults to 0-10000 bp with a bounded adjustable maximum', () => {
  assert.equal(DEFAULT_ISPCR_WEB_PARAMETERS.maxProductSize, 10000);
  assert.equal(ISPCR_WEB_CONSTRAINTS.minProductSize, 0);
  assert.deepEqual(normalizeIsPcrWebParameters({}), { minProductSize: 0, maxProductSize: 10000 });
  assert.deepEqual(normalizeIsPcrWebParameters({ maxProductSize: 50000 }), { minProductSize: 0, maxProductSize: 50000 });
  assert.throws(() => normalizeIsPcrWebParameters({ maxProductSize: 999 }), /between 1000 and 50000/);
  assert.throws(() => normalizeIsPcrWebParameters({ maxProductSize: 10000.5 }), /integer/);
  assert.throws(() => normalizeIsPcrWebParameters({ maxProductSize: 10000, extra: true }), /unknown fields/);
});

test('cached isPCR results are reusable only when every validation parameter matches', () => {
  const result = { tool: { parameters: {
    minSize: '0', maxSize: '10000', minPerfect: '15', minGood: '15', flipReverse: '0',
  } } };
  const parameters = { minSize: 0, maxSize: 10000, minPerfect: 15, minGood: 15, flipReverse: false };
  assert.equal(resultMatchesIsPcrParameters(result, parameters), true);
  assert.equal(resultMatchesIsPcrParameters(result, { ...parameters, maxSize: 1000 }), false);
  assert.equal(resultMatchesIsPcrParameters({ classification: 'pass_single_product' }, parameters), false);
});

const candidates = [
  { candidateId: 'pair-001', forwardSequence: 'ACGTACGTACGTACG', reverseSequence: 'TGCATGCATGCATGC' },
  { candidateId: 'pair-002', forwardSequence: 'AACCAACCAACCAAC', reverseSequence: 'GGTTGGTTGGTTGGT' },
  { candidateId: 'pair-003', forwardSequence: 'AGCTAGCTAGCTAGC', reverseSequence: 'TCGATCGATCGATCG' },
  { candidateId: 'pair-004', forwardSequence: 'AAAACCCCGGGGTTT', reverseSequence: 'TTTTGGGGCCCCAAA' },
];

const server = validateIsPcrServerConfig({
  hostAlias: 'Fdu_imi',
  remoteRoot: '/home/user/workspace/Codex_workspace/prime_design',
  slurmScript: '/home/user/workspace/Codex_workspace/prime_design/jobs/run-ispcr.slurm',
  timeoutMs: 7_200_000,
  supportedAssemblies: ['mm10', 'hg38', 'hs1'],
});

test('buildIsPcrQuery emits exactly three tab-separated columns', () => {
  const query = buildIsPcrQuery(candidates.slice(0, 2));
  assert.equal(query, [
    'pair-001\tACGTACGTACGTACG\tTGCATGCATGCATGC',
    'pair-002\tAACCAACCAACCAAC\tGGTTGGTTGGTTGGT',
    '',
  ].join('\n'));
});

test('buildBlatPrimerFasta preserves candidate IDs, roles, and sequences', () => {
  assert.equal(buildBlatPrimerFasta(candidates.slice(0, 1)), [
    '>pair-001_forward',
    'ACGTACGTACGTACG',
    '>pair-001_reverse',
    'TGCATGCATGCATGC',
    '',
  ].join('\n'));
});

test('parseIsPcrBed normalizes BED coordinates and classifies all candidate outcomes', () => {
  const bed = [
    'chr1\t99\t180\tpair-001\t1000\t+',
    'chr2\t200\t300\tpair-002\t900\t+',
    'chr2_KI270776v1_alt\t250\t350\tpair-002\t900\t+',
    'chr3\t300\t410\tpair-003\t800\t-',
    'chr7\t700\t820\tpair-003\t800\t+',
  ].join('\n');
  const parsed = parseIsPcrBed(bed, { candidates, assembly: 'hg38' });
  assert.equal(parsed['pair-001'].classification, 'pass_single_product');
  assert.deepEqual(
    [parsed['pair-001'].products[0].start0, parsed['pair-001'].products[0].start1,
      parsed['pair-001'].products[0].end0, parsed['pair-001'].products[0].end1,
      parsed['pair-001'].products[0].productSize],
    [99, 100, 180, 180, 81],
  );
  assert.equal(parsed['pair-002'].classification, 'review_patch_or_alt');
  assert.equal(parsed['pair-003'].classification, 'fail_multiple_loci');
  assert.equal(parsed['pair-004'].classification, 'no_product');
});

test('parseIsPcrBed rejects unknown candidate IDs instead of treating them as no product', () => {
  assert.throws(
    () => parseIsPcrBed('chr1\t0\t100\tpair-999\t0\t+\n', { candidates, assembly: 'hg38' }),
    /未知候选 ID/,
  );
});

test('parseBlatPsl retains per-primer alignments and exact-hit summaries', () => {
  const psl = [
    '15\t0\t0\t0\t0\t0\t0\t0\t+\tpair-001_forward\t15\t0\t15\tchr1\t1000\t99\t114\t1\t15,\t0,\t99,',
    '14\t1\t0\t0\t0\t0\t0\t0\t-\tpair-001_reverse\t15\t0\t15\tchr2\t2000\t200\t215\t1\t15,\t0,\t200,',
  ].join('\n');
  const parsed = parseBlatPsl(psl, { candidates: candidates.slice(0, 2), assembly: 'hg38' });
  assert.equal(parsed['pair-001'].blatSummary.forwardHits, 1);
  assert.equal(parsed['pair-001'].blatSummary.forwardFullLengthExact, 1);
  assert.equal(parsed['pair-001'].blatSummary.reverseFullLengthExact, 0);
  assert.equal(parsed['pair-001'].primerAlignments.forward[0].tStart1, 100);
  assert.equal(parsed['pair-002'].blatSummary.forwardHits, 0);
  assert.throws(
    () => parseBlatPsl(
      '14\t0\t0\t0\t0\t0\t0\t0\t+\tpair-001_forward\t14\t0\t14\tchr1\t1000\t99\t113\t1\t14,\t0,\t99,\n',
      { candidates: candidates.slice(0, 2), assembly: 'hg38' },
    ),
    /query/,
  );
  assert.throws(
    () => parseBlatPsl(
      '15\t0\t0\t0\t0\t0\t0\t0\t++\tpair-001_forward\t15\t0\t15\tchr1\t1000\t99\t114\t1\t15,\t0,\t99,\n',
      { candidates: candidates.slice(0, 2), assembly: 'hg38' },
    ),
    /链方向无效/,
  );
});

test('completion and result manifests reject drift and duplicate keys', () => {
  const completed = parseKeyValueTsv('key\tvalue\nschemaVersion\t1\nrunId\trun-1\n');
  assert.equal(completed.runId, 'run-1');
  assert.throws(() => parseKeyValueTsv('key\tvalue\nrunId\ta\nrunId\tb\n'), /重复/);

  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const manifest = parseResultManifest([
    'assembly\tdatabase\tdatabase_sha256\tispcr_result\tispcr_sha256\tispcr_hit_count\tblat_result\tblat_sha256\tblat_alignment_count',
    `hg38\t/ref/hg38.2bit\t${hashA}\t/run/hg38.bed\t${hashB}\t3\t/run/hg38.psl\t${hashA}\t8`,
  ].join('\n'));
  assert.equal(manifest.get('hg38').ispcr_hit_count, 3);
  assert.equal(manifest.get('hg38').blat_alignment_count, 8);
  assert.equal(manifest.get('hg38').blat_status, 'legacy_all_candidates');
  const current = parseResultManifest([
    'assembly\tdatabase\tdatabase_sha256\tispcr_result\tispcr_sha256\tispcr_hit_count\tblat_result\tblat_sha256\tblat_alignment_count\tblat_status\tblat_review_candidate_count',
    `mm10\t/ref/mm10.2bit\t${hashA}\t/run/mm10.bed\t${hashB}\t1\t/run/mm10.psl\t${hashA}\t0\tskipped_all_unique_primary\t0`,
  ].join('\n'));
  assert.equal(current.get('mm10').blat_status, 'skipped_all_unique_primary');
  assert.equal(current.get('mm10').blat_review_candidate_count, 0);
  assert.throws(
    () => parseResultManifest('assembly\tdatabase\tdatabase_sha256\tispcr_result\tispcr_sha256\tispcr_hit_count\tblat_result\tblat_sha256\tblat_alignment_count\nhg38\tx\tbad\ty\tbad\t0\tz\tbad\t0\n'),
    /SHA-256/,
  );
});

test('server config and sbatch arguments keep untrusted data out of a shell', () => {
  assert.throws(() => validateIsPcrServerConfig({
    hostAlias: 'server;touch',
    remoteRoot: '/safe/root',
    slurmScript: '/safe/root/jobs/run.slurm',
    supportedAssemblies: ['hg38'],
  }), /不安全字符/);
  assert.throws(() => validateIsPcrServerConfig({
    hostAlias: 'server',
    remoteRoot: '/safe/../root',
    slurmScript: '/safe/root/jobs/run.slurm',
    supportedAssemblies: ['hg38'],
  }), /无空格、无 \.\./);

  const args = buildSbatchRemoteArgs({
    server,
    runId: 'run-001',
    assemblies: ['hg38'],
    parameters: { minSize: 80, maxSize: 1000, minPerfect: 15, minGood: 15, flipReverse: false },
  });
  assert.equal(args[args.indexOf('sbatch') + 1], '--wait');
  assert.match(args.find((value) => value.startsWith('--export=')), /PRIME_RUN_ID=run-001/);
  assert.match(args.find((value) => value.startsWith('--export=')), /PRIME_ASSEMBLIES=hg38/);
  assert.equal(args.at(-1), server.slurmScript);
  assert.throws(() => buildSbatchRemoteArgs({
    server,
    runId: 'run-001',
    assemblies: ['mm39'],
    parameters: { minSize: 80, maxSize: 1000, minPerfect: 15, minGood: 15, flipReverse: false },
  }), /不支持组装/);
});

test('remote run IDs are deterministic, safe, and bounded', () => {
  const runId = makeRemoteRunId('random-4000-000080', new Date('2026-08-09T14:30:45.000Z'));
  assert.equal(runId, 'random-4000-000080-20260809T143045Z');
  assert.match(runId, /^[A-Za-z0-9._-]+$/);
  assert.ok(runId.length <= 128);
});
