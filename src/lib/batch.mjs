import { createHash } from 'node:crypto';

/**
 * The batch input format deliberately has a small, closed vocabulary.  Keeping
 * these values here (rather than accepting arbitrary assemblies/stages) makes
 * malformed input fail before any downstream design or validation work starts.
 */
export const MAX_BATCH_RECORDS = 20;
export const MIN_TEMPLATE_LENGTH = 80;
export const ALLOWED_ASSEMBLIES = Object.freeze(['hs1', 'hg38', 'mm10']);
export const BATCH_SCHEMA_VERSION = 1;
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const RECORD_STAGES = Object.freeze([
  'queued',
  'designed',
  'validated',
  'complete',
  'paused',
  'failed',
]);
export const ACTIVE_RECORD_STAGES = Object.freeze(['queued', 'designed', 'validated']);

const IUPAC_DNA = new Set('ACGTRYSWKMBDHVN'.split(''));
const PRIMER3_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MANIFEST_HEADER = Object.freeze(['sequence_id', 'fasta_record', 'assembly']);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defineAlias(target, name, value) {
  // Aliases are intentionally non-enumerable.  The serialized representation
  // remains deterministic while callers can use either camelCase or the
  // source file's snake_case terminology.
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return target;
}

function defineGetter(target, name, getter) {
  Object.defineProperty(target, name, {
    get: getter,
    enumerable: false,
    configurable: false,
  });
  return target;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeSequenceText(value, label = 'sequence') {
  if (typeof value !== 'string') fail(`${label} must be a string.`);

  // FASTA line wrapping and incidental whitespace are harmless; every other
  // character is checked after U/RNA normalization instead of being silently
  // discarded (digits and punctuation are not valid DNA symbols).
  const sequence = value.replace(/\s+/g, '').replace(/U/gi, 'T').toUpperCase();
  if (!sequence) fail(`${label} is empty.`);

  const invalid = [...new Set([...sequence].filter((base) => !IUPAC_DNA.has(base)))];
  if (invalid.length) fail(`${label} contains unsupported DNA symbols: ${invalid.join(', ')}.`);
  return sequence;
}

function makeFastaRecord({ id, header, sequence }) {
  const record = {
    id,
    sequence,
    length: sequence.length,
    sha256: sha256(sequence),
  };
  // Keep the original header available for UIs/audit code without making it
  // part of the canonical hash/JSON shape.
  defineAlias(record, 'header', header);
  defineAlias(record, 'fastaRecord', id);
  defineAlias(record, 'fasta_record', id);
  defineAlias(record, 'hash', record.sha256);
  defineAlias(record, 'sequenceId', id);
  return record;
}

/**
 * Parse a FASTA document containing one to twenty records.
 *
 * IDs follow the usual FASTA convention: the first whitespace-delimited token
 * after `>` is the record ID.  Empty IDs/sequences, duplicate IDs, plain text
 * before the first header, unsupported symbols, and more than twenty records
 * are all rejected.
 */
export function parseMultiFasta(input) {
  if (typeof input !== 'string') fail('FASTA input must be a string.');
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) fail('FASTA input is empty.');

  const records = [];
  const seen = new Set();
  let current = null;

  const finish = () => {
    if (!current) return;
    if (!current.lines.length) fail(`FASTA record ${current.id} has an empty sequence.`);
    const sequence = normalizeSequenceText(current.lines.join(''), `FASTA record ${current.id}`);
    records.push(makeFastaRecord({ id: current.id, header: current.header, sequence }));
    current = null;
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('>')) {
      finish();
      if (records.length >= MAX_BATCH_RECORDS) {
        fail(`FASTA input contains more than ${MAX_BATCH_RECORDS} records.`);
      }

      const header = line.slice(1).trim();
      const id = header.split(/\s+/)[0] || '';
      if (!id) fail(`FASTA header on line ${index + 1} has an empty ID.`);
      if (seen.has(id)) fail(`FASTA ID is duplicated: ${id}.`);
      seen.add(id);
      current = { id, header, lines: [] };
      continue;
    }

    if (!current) {
      fail(`FASTA sequence content appears before the first header on line ${index + 1}.`);
    }
    current.lines.push(line);
  }
  finish();

  if (!records.length) fail('FASTA input contains no records.');
  return records;
}

// Names used by callers that prefer an explicit batch prefix.
export const parseBatchFasta = parseMultiFasta;
export const parseFastaRecords = parseMultiFasta;

/**
 * Tolerant FASTA inspection for the local web UI. Unlike parseMultiFasta this
 * returns every discoverable problem so a user can correct a whole upload in
 * one pass. The strict parser is still used again when a batch is committed.
 */
export function previewMultiFasta(input, { minLength = MIN_TEMPLATE_LENGTH } = {}) {
  const errors = [];
  if (typeof input !== 'string') {
    return { valid: false, records: [], errors: [{ code: 'invalid_type', message: 'FASTA 内容必须是文本。' }] };
  }
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) {
    return { valid: false, records: [], errors: [{ code: 'empty_input', message: 'FASTA 内容为空。' }] };
  }

  const rawRecords = [];
  let current = null;
  const finish = () => {
    if (current) rawRecords.push(current);
    current = null;
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      finish();
      const header = line.slice(1).trim();
      current = { header, headerLine: index + 1, lines: [] };
    } else if (!current) {
      errors.push({
        code: 'content_before_header',
        line: index + 1,
        message: `第 ${index + 1} 行的序列出现在第一个 FASTA 标题之前。`,
      });
    } else {
      current.lines.push(line);
    }
  }
  finish();

  if (!rawRecords.length) {
    errors.push({ code: 'no_records', message: '未找到 FASTA 记录。' });
  }
  if (rawRecords.length > MAX_BATCH_RECORDS) {
    errors.push({
      code: 'too_many_records',
      message: `一次最多提交 ${MAX_BATCH_RECORDS} 条序列，当前为 ${rawRecords.length} 条。`,
    });
  }

  const seen = new Map();
  const records = rawRecords.map((raw, index) => {
    const recordErrors = [];
    const id = raw.header.split(/\s+/)[0] || '';
    if (!id) recordErrors.push(`第 ${raw.headerLine} 行的 FASTA 标题没有名称。`);
    if (id && !PRIMER3_SAFE_ID.test(id)) {
      recordErrors.push(`名称 ${id} 不符合 Primer3 ID 规则：须以字母或数字开头，仅含字母、数字、点、下划线或连字符，最长 80 个字符。`);
    }
    if (id && seen.has(id)) {
      recordErrors.push(`名称 ${id} 重复（首次出现于第 ${seen.get(id)} 行）。`);
    } else if (id) {
      seen.set(id, raw.headerLine);
    }

    const sequence = raw.lines.join('').replace(/\s+/g, '').replace(/U/gi, 'T').toUpperCase();
    if (!sequence) recordErrors.push(`记录 ${id || index + 1} 的序列为空。`);
    const invalid = [...new Set([...sequence].filter((base) => !IUPAC_DNA.has(base)))];
    if (invalid.length) recordErrors.push(`记录 ${id || index + 1} 含非法碱基：${invalid.join(', ')}。`);
    if (sequence && sequence.length < minLength) {
      recordErrors.push(`记录 ${id || index + 1} 只有 ${sequence.length} bp，短于最低 ${minLength} bp。`);
    }
    for (const message of recordErrors) {
      errors.push({ code: 'record_error', recordId: id || null, line: raw.headerLine, message });
    }
    return {
      id,
      header: raw.header,
      displayName: raw.header,
      length: sequence.length,
      sha256: sha256(sequence),
      errors: recordErrors,
    };
  });

  return { valid: errors.length === 0, records, errors };
}

function makeManifestEntry({ sequenceId, fastaRecord, assembly }) {
  const entry = { sequenceId, fastaRecord, assembly };
  defineAlias(entry, 'sequence_id', sequenceId);
  defineAlias(entry, 'fasta_record', fastaRecord);
  return entry;
}

/** Parse the strict three-column sequence_id/fasta_record/assembly TSV. */
export function parseManifestTsv(input) {
  if (typeof input !== 'string') fail('Manifest input must be a string.');
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) fail('Manifest input is empty.');

  const rawLines = text.split(/\r?\n/);
  // A single final newline is normal TSV formatting.  Blank rows anywhere else
  // are rejected because silently skipping one can orphan a sequence.
  if (rawLines.at(-1) === '') rawLines.pop();
  if (!rawLines.length || rawLines[0] !== MANIFEST_HEADER.join('\t')) {
    fail(`Manifest header must be exactly: ${MANIFEST_HEADER.join('\t')}.`);
  }
  if (rawLines.length === 1) fail('Manifest contains no records.');
  if (rawLines.length - 1 > MAX_BATCH_RECORDS) {
    fail(`Manifest contains more than ${MAX_BATCH_RECORDS} records.`);
  }

  const sequenceIds = new Set();
  const fastaRecords = new Set();
  const entries = [];
  for (let index = 1; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    if (!line.trim()) fail(`Manifest row ${index + 1} is empty.`);
    const fields = line.split('\t');
    if (fields.length !== MANIFEST_HEADER.length) {
      fail(`Manifest row ${index + 1} must contain exactly three tab-separated columns.`);
    }

    const [sequenceId, fastaRecord, assembly] = fields.map((value) => value.trim());
    if (!sequenceId || !fastaRecord || !assembly) {
      fail(`Manifest row ${index + 1} contains an empty field.`);
    }
    if (sequenceIds.has(sequenceId)) fail(`Manifest sequence_id is duplicated: ${sequenceId}.`);
    if (fastaRecords.has(fastaRecord)) fail(`Manifest fasta_record is duplicated: ${fastaRecord}.`);
    if (!ALLOWED_ASSEMBLIES.includes(assembly)) {
      fail(`Manifest assembly is not allowed: ${assembly}. Expected one of ${ALLOWED_ASSEMBLIES.join(', ')}.`);
    }

    sequenceIds.add(sequenceId);
    fastaRecords.add(fastaRecord);
    entries.push(makeManifestEntry({ sequenceId, fastaRecord, assembly }));
  }
  return entries;
}

export const parseBatchManifest = parseManifestTsv;
export const parseManifest = parseManifestTsv;

function normalizeParsedFastaRecords(value) {
  if (!Array.isArray(value)) fail('FASTA records must be an array.');
  if (!value.length) fail('FASTA records are empty.');
  if (value.length > MAX_BATCH_RECORDS) fail(`A batch may contain at most ${MAX_BATCH_RECORDS} records.`);

  const seen = new Set();
  return value.map((raw, index) => {
    if (!isObject(raw)) fail(`FASTA record ${index + 1} is not an object.`);
    const id = String(raw.id ?? raw.fastaRecord ?? raw.fasta_record ?? '').trim();
    if (!id) fail(`FASTA record ${index + 1} has an empty ID.`);
    if (seen.has(id)) fail(`FASTA ID is duplicated: ${id}.`);
    seen.add(id);
    const sequence = normalizeSequenceText(String(raw.sequence ?? ''), `FASTA record ${id}`);
    return makeFastaRecord({ id, header: String(raw.header ?? id), sequence });
  });
}

function normalizeManifestEntries(value) {
  if (!Array.isArray(value)) fail('Manifest records must be an array.');
  if (!value.length) fail('Manifest records are empty.');
  if (value.length > MAX_BATCH_RECORDS) fail(`A batch may contain at most ${MAX_BATCH_RECORDS} records.`);

  const seenIds = new Set();
  const seenFasta = new Set();
  return value.map((raw, index) => {
    if (!isObject(raw)) fail(`Manifest record ${index + 1} is not an object.`);
    const sequenceId = String(raw.sequenceId ?? raw.sequence_id ?? '').trim();
    const fastaRecord = String(raw.fastaRecord ?? raw.fasta_record ?? '').trim();
    const assembly = String(raw.assembly ?? '').trim();
    if (!sequenceId || !fastaRecord || !assembly) fail(`Manifest record ${index + 1} contains an empty field.`);
    if (seenIds.has(sequenceId)) fail(`Manifest sequence_id is duplicated: ${sequenceId}.`);
    if (seenFasta.has(fastaRecord)) fail(`Manifest fasta_record is duplicated: ${fastaRecord}.`);
    if (!ALLOWED_ASSEMBLIES.includes(assembly)) fail(`Manifest assembly is not allowed: ${assembly}.`);
    seenIds.add(sequenceId);
    seenFasta.add(fastaRecord);
    return makeManifestEntry({ sequenceId, fastaRecord, assembly });
  });
}

function unpackBatchInputs(input, maybeManifest) {
  if (typeof input === 'string' || Array.isArray(input)) {
    return { fasta: input, manifest: maybeManifest };
  }
  if (!isObject(input)) fail('Batch input must provide FASTA and manifest data.');
  return {
    fasta: input.fasta ?? input.fastaText ?? input.fastaRecords ?? input.records,
    manifest: input.manifest ?? input.manifestText ?? input.manifestRecords,
  };
}

function canonicalBatchString(records) {
  return records
    .map((record) => [record.sequenceId, record.fastaRecord, record.assembly, record.sha256, record.length].join('\t'))
    .join('\n');
}

function makeBatchRecord({ sequenceId, fastaRecord, assembly, source }) {
  const record = {
    sequenceId,
    fastaRecord,
    assembly,
    sequence: source.sequence,
    length: source.length,
    sha256: source.sha256,
  };
  defineAlias(record, 'sequence_id', sequenceId);
  defineAlias(record, 'fasta_record', fastaRecord);
  defineAlias(record, 'hash', source.sha256);
  defineAlias(record, 'id', sequenceId);
  return record;
}

/**
 * Join parsed FASTA records to the manifest.  Both directions are checked so
 * a typo cannot silently drop a sequence or create an unrequested one.
 */
export function buildBatch(input, maybeManifest) {
  const { fasta, manifest } = unpackBatchInputs(input, maybeManifest);
  const fastaRecords = typeof fasta === 'string' ? parseMultiFasta(fasta) : normalizeParsedFastaRecords(fasta);
  const manifestEntries = typeof manifest === 'string' ? parseManifestTsv(manifest) : normalizeManifestEntries(manifest);

  if (fastaRecords.length !== manifestEntries.length) {
    fail(`FASTA/manifest record counts differ (${fastaRecords.length} vs ${manifestEntries.length}).`);
  }

  const byFasta = new Map(fastaRecords.map((record) => [record.id, record]));
  const records = manifestEntries.map((entry) => {
    const source = byFasta.get(entry.fastaRecord);
    if (!source) fail(`Manifest references missing FASTA record: ${entry.fastaRecord}.`);
    return makeBatchRecord({ ...entry, source });
  });

  const mappedIds = new Set(manifestEntries.map((entry) => entry.fastaRecord));
  for (const source of fastaRecords) {
    if (!mappedIds.has(source.id)) fail(`FASTA record has no manifest row: ${source.id}.`);
  }

  const batch = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    records,
  };
  defineGetter(batch, 'batchSha256', () => sha256(canonicalBatchString(records)));
  defineGetter(batch, 'batchHash', () => batch.batchSha256);
  defineGetter(batch, 'recordCount', () => records.length);
  return batch;
}

export const createBatch = buildBatch;
export const parseBatch = buildBatch;

function ensureBatch(batch) {
  if (!isObject(batch) || !Array.isArray(batch.records)) fail('Batch must contain a records array.');
  if (batch.schemaVersion !== undefined && batch.schemaVersion !== BATCH_SCHEMA_VERSION) {
    fail(`Unsupported batch schemaVersion: ${batch.schemaVersion}.`);
  }
  if (!batch.records.length || batch.records.length > MAX_BATCH_RECORDS) {
    fail(`Batch must contain between one and ${MAX_BATCH_RECORDS} records.`);
  }

  const seen = new Set();
  return batch.records.map((record, index) => {
    if (!isObject(record)) fail(`Batch record ${index + 1} is not an object.`);
    const sequenceId = String(record.sequenceId ?? record.sequence_id ?? '').trim();
    if (!sequenceId) fail(`Batch record ${index + 1} has an empty sequenceId.`);
    if (seen.has(sequenceId)) fail(`Batch sequenceId is duplicated: ${sequenceId}.`);
    seen.add(sequenceId);
    const digest = String(record.sha256 ?? record.hash ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) fail(`Batch record ${sequenceId} has an invalid sha256.`);
    const length = Number(record.length);
    if (!Number.isInteger(length) || length <= 0) fail(`Batch record ${sequenceId} has an invalid length.`);
    return { sequenceId, sha256: digest, length };
  });
}

function batchDigest(batch) {
  if (typeof batch?.batchSha256 === 'string' && /^[0-9a-f]{64}$/i.test(batch.batchSha256)) {
    return batch.batchSha256.toLowerCase();
  }
  if (Array.isArray(batch?.records) && batch.records.every((record) => record?.fastaRecord && record?.assembly)) {
    return sha256(canonicalBatchString(batch.records));
  }
  return null;
}

function makeCheckpointRecord({ sequenceId, sha256: digest, stage = 'queued', resumeStage, error }) {
  const record = { sequenceId, stage };
  if (digest) record.sha256 = digest;
  if (stage === 'paused') record.resumeStage = resumeStage;
  if (stage === 'failed' && error !== undefined) record.error = error;
  // `status` is a read-only compatibility alias; the canonical checkpoint
  // field is `stage` so a single state vocabulary is serialized.
  defineGetter(record, 'status', () => record.stage);
  defineGetter(record, 'sequence_id', () => record.sequenceId);
  defineGetter(record, 'hash', () => record.sha256);
  return record;
}

/** Create a fresh, queued checkpoint for every batch record. */
export function createCheckpoint(batch) {
  const batchRecords = ensureBatch(batch);
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    batchSha256: batchDigest(batch),
    records: batchRecords.map((record) => makeCheckpointRecord({
      sequenceId: record.sequenceId,
      sha256: record.sha256,
    })),
  };
  if (!checkpoint.batchSha256) delete checkpoint.batchSha256;
  return checkpoint;
}

export const createBatchState = createCheckpoint;
export const initialBatchState = createCheckpoint;

function assertStage(stage) {
  if (!RECORD_STAGES.includes(stage)) fail(`Invalid record stage: ${stage}.`);
}

function validateCheckpointRecord(raw, index, seen) {
  if (!isObject(raw)) fail(`Checkpoint record ${index + 1} is not an object.`);
  const sequenceId = String(raw.sequenceId ?? raw.sequence_id ?? '').trim();
  if (!sequenceId) fail(`Checkpoint record ${index + 1} has an empty sequenceId.`);
  if (seen.has(sequenceId)) fail(`Checkpoint sequenceId is duplicated: ${sequenceId}.`);
  seen.add(sequenceId);
  const stage = raw.stage ?? raw.status;
  assertStage(stage);

  const digest = raw.sha256 ?? raw.hash;
  if (digest !== undefined && !/^[0-9a-f]{64}$/i.test(String(digest))) {
    fail(`Checkpoint record ${sequenceId} has an invalid sha256.`);
  }

  const normalized = makeCheckpointRecord({
    sequenceId,
    sha256: digest === undefined ? undefined : String(digest).toLowerCase(),
    stage,
    resumeStage: raw.resumeStage,
    error: raw.error,
  });

  if (stage === 'paused') {
    if (!ACTIVE_RECORD_STAGES.includes(raw.resumeStage)) {
      fail(`Paused checkpoint record ${sequenceId} must name an active resumeStage.`);
    }
  } else if (raw.resumeStage !== undefined) {
    fail(`Checkpoint record ${sequenceId} may only set resumeStage while paused.`);
  }
  if (stage === 'failed') {
    if (raw.error !== undefined && (typeof raw.error !== 'string' || !raw.error.trim())) {
      fail(`Failed checkpoint record ${sequenceId} has an invalid error message.`);
    }
  } else if (raw.error !== undefined) {
    fail(`Checkpoint record ${sequenceId} may only set error while failed.`);
  }
  return normalized;
}

/** Validate and normalize a checkpoint, optionally binding it to a batch. */
export function validateCheckpoint(checkpoint, batch) {
  if (!isObject(checkpoint) || checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    fail(`Unsupported checkpoint schemaVersion: ${checkpoint?.schemaVersion}.`);
  }
  if (!Array.isArray(checkpoint.records) || !checkpoint.records.length
    || checkpoint.records.length > MAX_BATCH_RECORDS) {
    fail(`Checkpoint records must contain between one and ${MAX_BATCH_RECORDS} entries.`);
  }

  let checkpointDigest;
  if (checkpoint.batchSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(String(checkpoint.batchSha256))) {
      fail('Checkpoint batchSha256 is invalid.');
    }
    checkpointDigest = String(checkpoint.batchSha256).toLowerCase();
  }

  const seen = new Set();
  const records = checkpoint.records.map((record, index) => validateCheckpointRecord(record, index, seen));
  const normalized = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    records,
  };
  if (checkpointDigest) normalized.batchSha256 = checkpointDigest;

  if (batch !== undefined) {
    const expected = ensureBatch(batch);
    if (records.length !== expected.length) {
      fail(`Checkpoint/batch record counts differ (${records.length} vs ${expected.length}).`);
    }
    const expectedById = new Map(expected.map((record) => [record.sequenceId, record]));
    for (const record of records) {
      const source = expectedById.get(record.sequenceId);
      if (!source) fail(`Checkpoint references unknown sequenceId: ${record.sequenceId}.`);
      if (record.sha256 !== undefined && record.sha256 !== source.sha256) {
        fail(`Checkpoint hash does not match batch record ${record.sequenceId}.`);
      }
    }
    for (const source of expected) {
      if (!seen.has(source.sequenceId)) fail(`Checkpoint is missing sequenceId: ${source.sequenceId}.`);
    }
    const expectedDigest = batchDigest(batch);
    if (checkpointDigest && expectedDigest && checkpointDigest !== expectedDigest) {
      fail('Checkpoint batchSha256 does not match the batch.');
    }
  }
  return normalized;
}

export const validateBatchState = validateCheckpoint;
export const validateBatchCheckpoint = validateCheckpoint;

function unpackTransitionArgs(sequenceIdOrOptions, nextStage, details) {
  if (isObject(sequenceIdOrOptions)) {
    return {
      sequenceId: String(sequenceIdOrOptions.sequenceId ?? sequenceIdOrOptions.sequence_id ?? '').trim(),
      nextStage: sequenceIdOrOptions.stage ?? sequenceIdOrOptions.nextStage,
      details: sequenceIdOrOptions,
    };
  }
  return { sequenceId: String(sequenceIdOrOptions ?? '').trim(), nextStage, details: details || {} };
}

/**
 * Apply one state-machine transition without mutating the input checkpoint.
 * `paused` records the active stage to resume; `failed` can carry a message.
 */
export function transitionCheckpoint(checkpoint, sequenceIdOrOptions, nextStage, details) {
  const current = validateCheckpoint(checkpoint);
  const request = unpackTransitionArgs(sequenceIdOrOptions, nextStage, details);
  if (!request.sequenceId) fail('A sequenceId is required for a checkpoint transition.');
  assertStage(request.nextStage);
  const index = current.records.findIndex((record) => record.sequenceId === request.sequenceId);
  if (index < 0) fail(`Checkpoint has no sequenceId: ${request.sequenceId}.`);
  const previous = current.records[index];

  if (previous.stage === 'complete') fail(`Completed record cannot transition: ${request.sequenceId}.`);
  if (previous.stage === 'paused') {
    if (request.nextStage !== previous.resumeStage && request.nextStage !== 'failed') {
      fail(`Paused record ${request.sequenceId} may only resume at ${previous.resumeStage}.`);
    }
  } else if (previous.stage === 'failed') {
    if (request.nextStage !== 'queued') fail(`Failed record ${request.sequenceId} must be retried from queued.`);
  } else if (request.nextStage !== 'paused' && request.nextStage !== 'failed') {
    const expected = {
      queued: 'designed',
      designed: 'validated',
      validated: 'complete',
    }[previous.stage];
    if (request.nextStage !== expected) {
      fail(`Invalid transition for ${request.sequenceId}: ${previous.stage} -> ${request.nextStage}.`);
    }
  }

  const replacement = { sequenceId: previous.sequenceId, stage: request.nextStage };
  if (previous.sha256) replacement.sha256 = previous.sha256;
  if (request.nextStage === 'paused') {
    replacement.resumeStage = request.details.resumeStage ?? previous.stage;
    if (previous.stage !== 'paused' && replacement.resumeStage !== previous.stage) {
      fail(`Paused record ${request.sequenceId} must resume at its current stage ${previous.stage}.`);
    }
    if (!ACTIVE_RECORD_STAGES.includes(replacement.resumeStage)) {
      fail(`Paused record ${request.sequenceId} must resume at an active stage.`);
    }
  }
  if (request.nextStage === 'failed') {
    const error = request.details.error ?? request.details.reason;
    if (error !== undefined && (typeof error !== 'string' || !error.trim())) {
      fail(`Failed record ${request.sequenceId} has an invalid error message.`);
    }
    if (error !== undefined) replacement.error = error;
  }

  const next = {
    schemaVersion: current.schemaVersion,
    records: current.records.map((record, recordIndex) => recordIndex === index ? replacement : { ...record }),
  };
  if (current.batchSha256) next.batchSha256 = current.batchSha256;
  return validateCheckpoint(next);
}

export const transitionBatchState = transitionCheckpoint;
export const transitionBatchRecord = transitionCheckpoint;
export const advanceBatchState = transitionCheckpoint;

function unpackResumeArgs(first, second) {
  if (isObject(first) && Array.isArray(first.records) && isObject(second) && Array.isArray(second.records)) {
    const firstLooksLikeBatch = first.records.some((record) => record?.sequence !== undefined);
    const secondLooksLikeBatch = second.records.some((record) => record?.sequence !== undefined);
    if (firstLooksLikeBatch && !secondLooksLikeBatch) return { batch: first, checkpoint: second };
    if (secondLooksLikeBatch && !firstLooksLikeBatch) return { batch: second, checkpoint: first };
  }
  // The checkpoint-first order is the natural API; when a batch is omitted,
  // callers can still select state records by passing only the checkpoint.
  return { checkpoint: first, batch: second };
}

/**
 * Select records needing work after a restart.  Completed records are never
 * returned.  When a batch is provided, each state record is merged with its
 * immutable sequence/assembly data so the caller can immediately resume it.
 */
export function selectResumeRecords(first, second) {
  const { checkpoint, batch } = unpackResumeArgs(first, second);
  const state = validateCheckpoint(checkpoint, batch);
  if (batch === undefined) return state.records.filter((record) => record.stage !== 'complete');

  const sourceById = new Map(batch.records.map((record) => [record.sequenceId, record]));
  return state.records
    .filter((record) => record.stage !== 'complete')
    .map((record) => ({ ...sourceById.get(record.sequenceId), stage: record.stage,
      ...(record.resumeStage ? { resumeStage: record.resumeStage } : {}),
      ...(record.error ? { error: record.error } : {}), }));
}

export const resumeRecords = selectResumeRecords;
export const selectBatchResumeRecords = selectResumeRecords;
