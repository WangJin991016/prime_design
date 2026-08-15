import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ASSEMBLIES,
  buildBatch,
  createBatchState,
  parseManifestTsv,
  parseMultiFasta,
  previewMultiFasta,
  selectResumeRecords,
  transitionBatchState,
  validateCheckpoint,
} from '../src/lib/batch.mjs';

const fasta = [
  '>alpha description',
  'acgu rysw',
  '>beta',
  'NNNNACGT',
].join('\n');
const manifest = [
  'sequence_id\tfasta_record\tassembly',
  'seq-1\talpha\ths1',
  'seq-2\tbeta\thg38',
].join('\n');

test('parseMultiFasta normalizes RNA/IUPAC and returns deterministic hashes', () => {
  const records = parseMultiFasta(fasta);
  assert.deepEqual(records.map(({ id, sequence, length }) => ({ id, sequence, length })), [
    { id: 'alpha', sequence: 'ACG T'.replace(/ /g, '') + 'RYSW', length: 8 },
    { id: 'beta', sequence: 'NNNNACGT', length: 8 },
  ]);
  assert.match(records[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(records[0].fastaRecord, 'alpha');
  assert.equal(records[0].hash, records[0].sha256);
});

test('parseMultiFasta rejects empty/duplicate IDs, invalid symbols, and >20 records', () => {
  assert.throws(() => parseMultiFasta('>\nACGT'), /empty ID/);
  assert.throws(() => parseMultiFasta('>x\nACGT\n>x\nTGCA'), /duplicated/);
  assert.throws(() => parseMultiFasta('>x\nACG1'), /unsupported DNA symbols/);
  assert.throws(() => parseMultiFasta('>x\n>y\nACGT'), /empty sequence/);
  const tooMany = Array.from({ length: 21 }, (_, index) => `>s${index + 1}\nA`).join('\n');
  assert.throws(() => parseMultiFasta(tooMany), /more than 20/);
});

test('previewMultiFasta reports all visible errors and enforces web template/ID rules', () => {
  const preview = previewMultiFasta([
    '>bad id',
    'ACGT',
    '>bad',
    'ACG1',
    '>bad',
    'ACGT',
  ].join('\r\n'));
  assert.equal(preview.valid, false);
  assert.ok(preview.errors.length >= 4);
  assert.match(preview.errors.map((entry) => entry.message).join(' '), /短于最低 80 bp/);
  assert.match(preview.errors.map((entry) => entry.message).join(' '), /重复/);
  assert.match(preview.errors.map((entry) => entry.message).join(' '), /非法碱基/);
  const unsafe = previewMultiFasta(`>bad/id\n${'A'.repeat(80)}`);
  assert.match(unsafe.errors[0].message, /Primer3 ID/);
});

test('previewMultiFasta accepts 1, 5, and 20 web records with CRLF input', () => {
  for (const count of [1, 5, 20]) {
    const input = Array.from({ length: count }, (_, index) => `>web_${index + 1} display name\r\n${'ACGT'.repeat(25)}`).join('\r\n');
    const preview = previewMultiFasta(input);
    assert.equal(preview.valid, true);
    assert.equal(preview.records.length, count);
  }
});


test('accepts the supported 1, 5, and 20 record batch sizes with mixed assemblies', () => {
  for (const count of [1, 5, 20]) {
    const fastaText = Array.from({ length: count }, (_, index) => `>r${index + 1}\nACGTACGT`).join('\n');
    const manifestText = [
      'sequence_id\tfasta_record\tassembly',
      ...Array.from({ length: count }, (_, index) => `s${index + 1}\tr${index + 1}\t${ALLOWED_ASSEMBLIES[index % 3]}`),
    ].join('\n');
    const batch = buildBatch({ fasta: fastaText, manifest: manifestText });
    assert.equal(batch.records.length, count);
  }
});

test('parseManifestTsv enforces exact columns, one-to-one rows, and assembly allowlist', () => {
  const entries = parseManifestTsv(`${manifest}\n`);
  assert.deepEqual(entries, [
    { sequenceId: 'seq-1', fastaRecord: 'alpha', assembly: 'hs1' },
    { sequenceId: 'seq-2', fastaRecord: 'beta', assembly: 'hg38' },
  ]);
  assert.deepEqual(ALLOWED_ASSEMBLIES, ['hs1', 'hg38', 'mm10']);
  assert.throws(() => parseManifestTsv('sequence_id\tfasta_record\tassembly\na\ta\tbad'), /not allowed/);
  assert.throws(() => parseManifestTsv(
    'sequence_id\tfasta_record\tassembly\na\ta\ths1\na\tb\thg38',
  ), /sequence_id is duplicated/);
  assert.throws(() => parseManifestTsv(
    'sequence_id\tfasta_record\tassembly\na\ta\ths1\nb\ta\thg38',
  ), /fasta_record is duplicated/);
  assert.throws(() => parseManifestTsv(
    'sequence_id\tfasta_record\tassembly\na\ta',
  ), /exactly three/);
});

test('buildBatch rejects missing/orphan mappings and exposes sequence/hash/length', () => {
  const batch = buildBatch({ fasta, manifest });
  assert.equal(batch.schemaVersion, 1);
  assert.equal(batch.records.length, 2);
  assert.deepEqual(batch.records.map(({ sequenceId, fastaRecord, assembly, length }) => ({
    sequenceId, fastaRecord, assembly, length,
  })), [
    { sequenceId: 'seq-1', fastaRecord: 'alpha', assembly: 'hs1', length: 8 },
    { sequenceId: 'seq-2', fastaRecord: 'beta', assembly: 'hg38', length: 8 },
  ]);
  assert.equal(batch.records[0].hash, batch.records[0].sha256);
  assert.match(batch.batchSha256, /^[0-9a-f]{64}$/);

  const missing = manifest.replace('beta\thg38', 'missing\thg38');
  assert.throws(() => buildBatch({ fasta, manifest: missing }), /missing FASTA record/);
  const orphan = `${manifest}\nseq-3\tgamma\tmm10`;
  assert.throws(() => buildBatch({ fasta, manifest: orphan }), /record counts differ|missing FASTA/);
  const orphanFasta = `${fasta}\n>gamma\nACGT`;
  assert.throws(() => buildBatch({ fasta: orphanFasta, manifest }), /record counts differ|no manifest row/);
});

test('checkpoint state transitions are monotonic and resume excludes complete records', () => {
  const batch = buildBatch({ fasta, manifest });
  let checkpoint = createBatchState(batch);
  assert.deepEqual(checkpoint.records.map((record) => record.stage), ['queued', 'queued']);
  checkpoint = transitionBatchState(checkpoint, 'seq-1', 'designed');
  checkpoint = transitionBatchState(checkpoint, 'seq-1', 'validated');
  checkpoint = transitionBatchState(checkpoint, 'seq-1', 'complete');
  checkpoint = transitionBatchState(checkpoint, { sequenceId: 'seq-2', stage: 'paused' }, undefined);
  assert.equal(checkpoint.records[1].stage, 'paused');
  assert.equal(checkpoint.records[1].resumeStage, 'queued');
  assert.deepEqual(selectResumeRecords(checkpoint, batch).map((record) => record.sequenceId), ['seq-2']);
  assert.deepEqual(selectResumeRecords(batch, checkpoint).map((record) => record.sequenceId), ['seq-2']);
  assert.throws(() => transitionBatchState(checkpoint, 'seq-1', 'queued'), /Completed record/);
  assert.throws(() => transitionBatchState(checkpoint, 'seq-2', 'validated'), /may only resume/);
});

test('checkpoint validation fails closed on schema, identity, and hash drift', () => {
  const batch = buildBatch({ fasta, manifest });
  const checkpoint = createBatchState(batch);
  assert.deepEqual(validateCheckpoint(checkpoint, batch), checkpoint);
  assert.throws(() => validateCheckpoint({ ...checkpoint, schemaVersion: 2 }, batch), /schemaVersion/);
  assert.throws(() => validateCheckpoint({ ...checkpoint, records: checkpoint.records.slice(0, 1) }, batch), /counts differ/);
  assert.throws(() => validateCheckpoint({
    ...checkpoint,
    records: checkpoint.records.map((record, index) => index === 0 ? { ...record, sequenceId: 'other' } : record),
  }, batch), /unknown sequenceId/);
  assert.throws(() => validateCheckpoint({
    ...checkpoint,
    records: checkpoint.records.map((record, index) => index === 0 ? { ...record, sha256: '0'.repeat(64) } : record),
  }, batch), /hash does not match/);
  assert.throws(() => validateCheckpoint({
    ...checkpoint,
    records: checkpoint.records.map((record, index) => index === 0
      ? { ...record, stage: 'paused' }
      : record),
  }), /resumeStage/);
});
