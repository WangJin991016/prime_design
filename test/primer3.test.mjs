import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRIMER3_PARAMETERS,
  DEFAULT_PRIMER3_WEB_PARAMETERS,
  buildPrimer3Input,
  buildPrimer3SbatchRemoteArgs,
  normalizePrimer3WebParameters,
  parsePrimer3CompletedTsv,
  parsePrimer3Output,
  validatePrimer3ServerConfig,
} from '../src/lib/primer3.mjs';

const records = [
  { sequenceId: 'target_001', sequence: 'ACGT'.repeat(100) },
  { sequenceId: 'target_002', sequence: 'TGCA'.repeat(100) },
];

test('buildPrimer3Input emits deterministic multi-record Boulder-IO', () => {
  const text = buildPrimer3Input(records);
  assert.equal((text.match(/^=$/gm) || []).length, 2);
  assert.match(text, /PRIMER_NUM_RETURN=5/);
  assert.match(text, /PRIMER_MIN_SIZE=18/);
  assert.match(text, /PRIMER_OPT_TM=60/);
  assert.match(text, /PRIMER_MIN_GC=40/);
  assert.match(text, /PRIMER_MAX_GC=60/);
  assert.match(text, /PRIMER_PRODUCT_SIZE_RANGE=80-1000/);
  assert.ok(text.endsWith('=\n'));
  assert.equal(DEFAULT_PRIMER3_PARAMETERS.numReturn, 5);
  assert.equal(DEFAULT_PRIMER3_WEB_PARAMETERS.tmToleranceC, 5);
  assert.throws(() => buildPrimer3Input([{ sequenceId: 'bad;id', sequence: 'ACGT' }]), /unsafe/);
  assert.match(buildPrimer3Input(records, { numReturn: 20 }), /PRIMER_NUM_RETURN=20/);
  assert.throws(() => buildPrimer3Input(records, { numReturn: 21 }), /cannot exceed/);
  assert.throws(() => buildPrimer3Input(records, { numReturn: 1.5 }), /integer/);
});

test('web parameters derive Tm bounds and reject coercion, unknown fields, and invalid ranges', () => {
  const normalized = normalizePrimer3WebParameters({ tmTargetC: 62, tmToleranceC: 3, numReturn: 20 });
  assert.deepEqual(
    [normalized.primer3.tmMinC, normalized.primer3.tmOptC, normalized.primer3.tmMaxC],
    [59, 62, 65],
  );
  assert.equal(normalized.primer3.explain, true);
  for (const value of ['', null, true, '5']) {
    assert.throws(() => normalizePrimer3WebParameters({ numReturn: value }), /JSON number/);
  }
  assert.throws(() => normalizePrimer3WebParameters({ extra: 1 }), /unknown fields/);
  assert.throws(() => normalizePrimer3WebParameters({ primerLengthMin: 30, primerLengthOpt: 25 }), /bounds/);
  assert.throws(() => normalizePrimer3WebParameters({ primerLengthMax: 36 }), /cannot exceed/);
  assert.throws(() => normalizePrimer3WebParameters({ gcMinPercent: 61, gcMaxPercent: 60 }), /GC bounds/);
  assert.throws(() => normalizePrimer3WebParameters({ productSizeMin: 1001, productSizeMax: 1000 }), /minimum/);
  assert.throws(() => normalizePrimer3WebParameters({ tmToleranceC: -1 }), /negative/);
});

function successfulRecord(sequenceId, template, { warning = '' } = {}) {
  const forward = template.slice(10, 30);
  const reverse = 'ACGTACGTACGTACGTACGT';
  return [
    `SEQUENCE_ID=${sequenceId}`,
    'PRIMER_PAIR_NUM_RETURNED=1',
    'PRIMER_LEFT_NUM_RETURNED=1',
    'PRIMER_RIGHT_NUM_RETURNED=1',
    ...(warning ? [`PRIMER_WARNING=${warning}`] : []),
    'PRIMER_LEFT_EXPLAIN=considered 100, ok 1',
    'PRIMER_RIGHT_EXPLAIN=considered 100, ok 1',
    'PRIMER_PAIR_EXPLAIN=considered 1, ok 1',
    'PRIMER_LEFT_0=10,20',
    'PRIMER_RIGHT_0=199,20',
    `PRIMER_LEFT_0_SEQUENCE=${forward}`,
    `PRIMER_RIGHT_0_SEQUENCE=${reverse}`,
    'PRIMER_LEFT_0_TM=60.1',
    'PRIMER_RIGHT_0_TM=59.9',
    'PRIMER_LEFT_0_GC_PERCENT=50',
    'PRIMER_RIGHT_0_GC_PERCENT=50',
    'PRIMER_PAIR_0_PRODUCT_SIZE=190',
    'PRIMER_PAIR_0_PENALTY=0.42',
    '=',
  ].join('\n');
}

function recordWithCandidateCount(sequenceId, template, count) {
  const lines = [
    `SEQUENCE_ID=${sequenceId}`,
    `PRIMER_PAIR_NUM_RETURNED=${count}`,
    `PRIMER_LEFT_NUM_RETURNED=${count}`,
    `PRIMER_RIGHT_NUM_RETURNED=${count}`,
  ];
  for (let index = 0; index < count; index += 1) {
    const leftStart = 10 + index;
    const rightmost = 199 + index;
    lines.push(
      `PRIMER_LEFT_${index}=${leftStart},20`,
      `PRIMER_RIGHT_${index}=${rightmost},20`,
      `PRIMER_LEFT_${index}_SEQUENCE=${template.slice(leftStart, leftStart + 20)}`,
      `PRIMER_RIGHT_${index}_SEQUENCE=ACGTACGTACGTACGTACGT`,
      `PRIMER_LEFT_${index}_TM=60.1`,
      `PRIMER_RIGHT_${index}_TM=59.9`,
      `PRIMER_LEFT_${index}_GC_PERCENT=50`,
      `PRIMER_RIGHT_${index}_GC_PERCENT=50`,
      `PRIMER_PAIR_${index}_PRODUCT_SIZE=${rightmost - leftStart + 1}`,
      `PRIMER_PAIR_${index}_PENALTY=${index / 10}`,
    );
  }
  lines.push('=');
  return lines.join('\n');
}

test('parsePrimer3Output preserves mixed success and per-record error outcomes', () => {
  const text = [
    successfulRecord('target_001', records[0].sequence, { warning: 'example warning' }),
    [
      'SEQUENCE_ID=target_002',
      'PRIMER_ERROR=Specified left primer is illegal',
      'PRIMER_PAIR_NUM_RETURNED=0',
      '=',
    ].join('\n'),
    '',
  ].join('\n');
  const parsed = parsePrimer3Output(text, { expectedRecords: records });
  assert.equal(parsed.records[0].status, 'ok');
  assert.equal(parsed.records[0].warnings[0], 'example warning');
  assert.equal(parsed.records[0].candidates[0].candidateId, 'target_001.p3.01');
  assert.equal(parsed.records[0].candidates[0].reversePosition, 180);
  assert.equal(parsed.records[0].candidates[0].productLength, 190);
  assert.equal(parsed.records[1].status, 'primer3_error');
  assert.equal(parsed.records[1].candidates.length, 0);
});

test('parser keeps the 20-pair safety ceiling independent from the 5-pair default', () => {
  const parsed = parsePrimer3Output(`${recordWithCandidateCount('target_001', records[0].sequence, 20)}\n`, {
    expectedRecords: records.slice(0, 1),
  });
  assert.equal(parsed.records[0].candidates.length, 20);
  assert.equal(parsed.records[0].candidates.at(-1).candidateId, 'target_001.p3.20');
  assert.throws(() => parsePrimer3Output(`${recordWithCandidateCount('target_001', records[0].sequence, 21)}\n`, {
    expectedRecords: records.slice(0, 1),
  }), /more than 20/);
});

test('parsePrimer3Output fails closed on malformed output', () => {
  const base = successfulRecord('target_001', records[0].sequence);
  assert.throws(() => parsePrimer3Output(base.replace(/\n=$/, ''), { expectedRecords: records.slice(0, 1) }), /terminator/);
  assert.throws(() => parsePrimer3Output(base.replace('PRIMER_LEFT_0=10,20', 'PRIMER_LEFT_0=500,20'), {
    expectedRecords: records.slice(0, 1),
  }), /outside/);
  assert.throws(() => parsePrimer3Output(`${base}\n${base}\n`, { expectedRecords: records }), /duplicate|Unexpected/);
});

test('Primer3 server configuration and sbatch vector reject injection', () => {
  const server = validatePrimer3ServerConfig({
    hostAlias: 'Fdu_imi',
    remoteRoot: '/home/u22111510029/workspace/Codex_workspace/prime_design',
    slurmScript: '/home/u22111510029/workspace/Codex_workspace/prime_design/jobs/run-primer3.slurm',
  });
  const args = buildPrimer3SbatchRemoteArgs({ server, runId: 'batch-001-p3' });
  assert.equal(args[args.indexOf('sbatch') + 1], '--wait');
  assert.equal(args.at(-1), server.slurmScript);
  assert.match(args.find((item) => item.startsWith('--export=')), /PRIMER3_RUN_ID=batch-001-p3/);
  assert.throws(() => validatePrimer3ServerConfig({
    hostAlias: 'bad;host', remoteRoot: '/safe/root', slurmScript: '/safe/root/jobs/run-primer3.slurm',
  }), /unsafe/);
  assert.throws(() => validatePrimer3ServerConfig({
    hostAlias: 'server', remoteRoot: '/safe/root', slurmScript: '/other/run-primer3.slurm',
  }), /fixed/);
});

test('parsePrimer3CompletedTsv rejects duplicate provenance keys', () => {
  const parsed = parsePrimer3CompletedTsv('key\tvalue\nschemaVersion\t1\nrunId\tx\n');
  assert.equal(parsed.runId, 'x');
  assert.throws(() => parsePrimer3CompletedTsv('key\tvalue\nrunId\tx\nrunId\ty\n'), /duplicate/);
});
