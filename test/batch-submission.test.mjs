import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchSubmission,
  buildWebBatchConfiguration,
  primer3ParametersForBatchConfig,
  validationCacheDescriptor,
  validationCacheKey,
} from '../src/batch-cli.mjs';

const fastaText = [
  '>human_one first display', 'ACGT'.repeat(25),
  '>human_two second display', 'TGCA'.repeat(25),
  '>mouse_one mouse display', 'GATC'.repeat(25),
].join('\n');

const assignments = [
  { sequenceId: 'human_one', displayName: '人样本 1' },
  { sequenceId: 'human_two', displayName: '人样本 2' },
  { sequenceId: 'mouse_one', displayName: '小鼠样本' },
];

test('validation cache key covers primers, assembly, parameters, tools and database', () => {
  const hash = (character) => character.repeat(64);
  const server = {
    expectedIsPcrSha256: hash('a'), expectedBlatSha256: hash('b'),
    expectedProvisionManifestSha256: hash('c'), expectedRunScriptSha256: hash('e'),
    expectedDatabaseSha256: { mm10: hash('d') },
  };
  const candidate = { forwardSequence: 'ACGTACGT', reverseSequence: 'TGCATGCA' };
  const parameters = { minSize: 0, maxSize: 10000, minPerfect: 15, minGood: 15, flipReverse: false };
  const descriptor = validationCacheDescriptor(candidate, 'mm10', parameters, server);
  const key = validationCacheKey(descriptor);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(validationCacheKey(validationCacheDescriptor(
    { ...candidate, reverseSequence: 'TGCATGCG' }, 'mm10', parameters, server,
  )), key);
  assert.notEqual(validationCacheKey(validationCacheDescriptor(
    candidate, 'mm10', { ...parameters, maxSize: 9999 }, server,
  )), key);
  assert.equal(validationCacheDescriptor(candidate, 'hg38', parameters, server), null);
});

test('web submission applies one assembly to every record without losing display names', () => {
  const submission = buildBatchSubmission({ fastaText, assignments, assembly: 'hs1', name: '统一批次' });
  assert.deepEqual(submission.parsed.records.map((record) => record.assembly), ['hs1', 'hs1', 'hs1']);
  assert.deepEqual(submission.displayNames, {
    human_one: '人样本 1', human_two: '人样本 2', mouse_one: '小鼠样本',
  });
  assert.match(submission.manifestText, /human_two\thuman_two\ths1/);
});

test('web submission rejects missing, duplicate, unknown, or over-specified assignments', () => {
  assert.throws(() => buildBatchSubmission({ fastaText, assignments: assignments.slice(0, 2), assembly: 'hs1', name: 'x' }), /每条 FASTA/);
  assert.throws(() => buildBatchSubmission({
    fastaText,
    assignments: [assignments[0], assignments[0], assignments[2]],
    assembly: 'hs1',
    name: 'x',
  }), /重复/);
  assert.throws(() => buildBatchSubmission({
    fastaText,
    assignments: assignments.map((entry, index) => index === 0 ? { ...entry, extra: true } : entry),
    assembly: 'hs1',
    name: 'x',
  }), /未知字段/);
  assert.throws(() => buildBatchSubmission({
    fastaText, assignments: assignments.map((entry) => ({ ...entry, assembly: 'hs1' })), assembly: 'hs1', name: 'x',
  }), /未知字段/);
  assert.throws(() => buildBatchSubmission({ fastaText, assignments, assembly: '', name: 'x' }), /有效 assembly/);
  assert.throws(() => buildBatchSubmission({ fastaText, assignments, assembly: 'bad', name: 'x' }), /有效 assembly/);
  assert.throws(() => buildBatchSubmission({ fastaText, assignments, assembly: 'hs1', name: '' }), /批次名称/);
});

test('web submission supports 1, 5, and 20 records with a single selected assembly', () => {
  for (const count of [1, 5, 20]) {
    const fasta = Array.from({ length: count }, (_, index) => `>seq_${index + 1}\n${'ACGT'.repeat(25)}`).join('\n');
    const names = Array.from({ length: count }, (_, index) => ({
      sequenceId: `seq_${index + 1}`, displayName: `样本 ${index + 1}`,
    }));
    const submission = buildBatchSubmission({ fastaText: fasta, assignments: names, assembly: 'mm10', name: `batch-${count}` });
    assert.equal(submission.parsed.records.length, count);
    assert.ok(submission.parsed.records.every((record) => record.assembly === 'mm10'));
  }
});

test('web batch configuration freezes normalized parameters without mutating global defaults', () => {
  const source = { schemaVersion: 1, primer3: { server: { hostAlias: 'Fdu_imi' } }, ucsc: { maxProductSize: 1000 } };
  const { config, designSettings } = buildWebBatchConfiguration(source, 'hg38', {
    numReturn: 20,
    tmTargetC: 61,
    tmToleranceC: 4,
    primerLengthMin: 18,
    primerLengthOpt: 22,
    primerLengthMax: 27,
    productSizeMin: 90,
    productSizeMax: 850,
    gcMinPercent: 42,
    gcMaxPercent: 58,
  }, { maxProductSize: 12000, parallelism: 6 });
  assert.equal(source.primer3.parameters, undefined);
  assert.equal(config.primer3.server.hostAlias, 'Fdu_imi');
  assert.deepEqual([config.primer3.parameters.tmMinC, config.primer3.parameters.tmOptC, config.primer3.parameters.tmMaxC], [57, 61, 65]);
  assert.equal(config.ucsc.minProductSize, 0);
  assert.equal(config.ucsc.maxProductSize, 12000);
  assert.equal(config.ucsc.parallelism, 6);
  assert.equal(designSettings.assembly, 'hg38');
  assert.equal(designSettings.primer3.numReturn, 20);
  assert.deepEqual(designSettings.validation, { minProductSize: 0, maxProductSize: 12000, parallelism: 6 });
  assert.throws(() => buildWebBatchConfiguration(source, 'hg38', { numReturn: 21 }, { maxProductSize: 12000 }), /cannot exceed 20/);
  assert.throws(() => buildWebBatchConfiguration(source, 'hg38', {}, { maxProductSize: 999 }), /between 1000 and 50000/);
  assert.throws(() => buildWebBatchConfiguration(source, 'hg38', {}, { maxProductSize: 12000, parallelism: 9 }), /parallelism/);
});

test('legacy batch snapshots keep their recorded count and native GC behavior', () => {
  const legacy = { primer3: { parameters: { numReturn: 11, tmMinC: 55, tmOptC: 60, tmMaxC: 65 } } };
  const parameters = primer3ParametersForBatchConfig(legacy);
  assert.equal(parameters.numReturn, 11);
  assert.deepEqual([parameters.gcMinPercent, parameters.gcMaxPercent], [20, 80]);
  assert.equal(legacy.primer3.parameters.gcMinPercent, undefined);
});
