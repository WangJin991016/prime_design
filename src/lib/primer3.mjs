import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertADrive } from './job.mjs';
import { runProcess, waitForSlurmCompletion } from './ispcr.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const DNA = /^[ACGTRYSWKMBDHVN]+$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export const PRIMER3_VERSION = '2.6.1';
export const PRIMER3_SOURCE_COMMIT = '7f9f17d6012f404e83bbf0f931a4d06eb4af465b';
export const PRIMER3_SOURCE_SHA256 = 'c981e42765ceb525f56607c6a7cf989ac5068483731c6e083b1e9fb22816463b';
export const MAX_PRIMER3_CANDIDATES = 20;
export const DEFAULT_PRIMER3_WEB_PARAMETERS = Object.freeze({
  numReturn: 5,
  tmTargetC: 60,
  tmToleranceC: 5,
  primerLengthMin: 18,
  primerLengthOpt: 23,
  primerLengthMax: 28,
  productSizeMin: 80,
  productSizeMax: 1000,
  gcMinPercent: 40,
  gcMaxPercent: 60,
});
export const PRIMER3_WEB_CONSTRAINTS = Object.freeze({
  numReturn: Object.freeze({ min: 1, max: MAX_PRIMER3_CANDIDATES, integer: true }),
  primerLength: Object.freeze({ min: 1, max: 35, integer: true }),
  productSize: Object.freeze({ min: 1, integer: true }),
  gcPercent: Object.freeze({ min: 0, max: 100 }),
  tmToleranceC: Object.freeze({ min: 0 }),
});
export const DEFAULT_PRIMER3_PARAMETERS = Object.freeze({
  numReturn: 5,
  primerLengthMin: 18,
  primerLengthOpt: 23,
  primerLengthMax: 28,
  tmMinC: 55,
  tmOptC: 60,
  tmMaxC: 65,
  productSizeMin: 80,
  productSizeMax: 1000,
  gcMinPercent: 40,
  gcMaxPercent: 60,
  explain: true,
});

function safeId(value, label) {
  const result = String(value ?? '');
  if (!SAFE_ID.test(result)) throw new Error(`${label} contains unsafe characters: ${result}`);
  return result;
}

function safeRemotePath(value, label) {
  const result = String(value ?? '').replace(/\/$/, '');
  if (!SAFE_REMOTE_PATH.test(result) || result.split('/').includes('..')) {
    throw new Error(`${label} must be an absolute POSIX path without spaces or '..'.`);
  }
  return result;
}

function integer(value, label, minimum = 0) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum) throw new Error(`${label} must be an integer >= ${minimum}.`);
  return result;
}

function finite(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be finite.`);
  return result;
}

export function normalizePrimer3Parameters(value = {}) {
  const p = { ...DEFAULT_PRIMER3_PARAMETERS, ...value };
  p.numReturn = integer(p.numReturn, 'numReturn', 1);
  if (p.numReturn > MAX_PRIMER3_CANDIDATES) {
    throw new Error(`numReturn cannot exceed ${MAX_PRIMER3_CANDIDATES} in this workflow.`);
  }
  for (const key of ['primerLengthMin', 'primerLengthOpt', 'primerLengthMax', 'productSizeMin', 'productSizeMax']) {
    p[key] = integer(p[key], key, 1);
  }
  for (const key of ['tmMinC', 'tmOptC', 'tmMaxC', 'gcMinPercent', 'gcMaxPercent']) p[key] = finite(p[key], key);
  if (!(p.primerLengthMin <= p.primerLengthOpt && p.primerLengthOpt <= p.primerLengthMax)) {
    throw new Error('Primer length bounds must satisfy min <= opt <= max.');
  }
  if (p.primerLengthMax > PRIMER3_WEB_CONSTRAINTS.primerLength.max) {
    throw new Error(`primerLengthMax cannot exceed ${PRIMER3_WEB_CONSTRAINTS.primerLength.max}.`);
  }
  if (!(p.tmMinC <= p.tmOptC && p.tmOptC <= p.tmMaxC)) throw new Error('Tm bounds must satisfy min <= opt <= max.');
  if (p.productSizeMin > p.productSizeMax) throw new Error('Product size minimum cannot exceed maximum.');
  if (p.gcMinPercent < 0 || p.gcMaxPercent > 100 || p.gcMinPercent > p.gcMaxPercent) {
    throw new Error('GC bounds must satisfy 0 <= min <= max <= 100.');
  }
  p.explain = p.explain !== false;
  return p;
}

export function normalizePrimer3WebParameters(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('primer3Parameters must be an object.');
  }
  const allowed = Object.keys(DEFAULT_PRIMER3_WEB_PARAMETERS);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`primer3Parameters contains unknown fields: ${unknown.join(', ')}.`);
  const ui = { ...DEFAULT_PRIMER3_WEB_PARAMETERS, ...value };
  for (const key of allowed) {
    if (typeof ui[key] !== 'number' || !Number.isFinite(ui[key])) {
      throw new Error(`${key} must be a finite JSON number.`);
    }
  }
  ui.numReturn = integer(ui.numReturn, 'numReturn', 1);
  if (ui.numReturn > MAX_PRIMER3_CANDIDATES) {
    throw new Error(`numReturn cannot exceed ${MAX_PRIMER3_CANDIDATES} in this workflow.`);
  }
  for (const key of ['primerLengthMin', 'primerLengthOpt', 'primerLengthMax', 'productSizeMin', 'productSizeMax']) {
    ui[key] = integer(ui[key], key, 1);
  }
  for (const key of ['tmTargetC', 'tmToleranceC', 'gcMinPercent', 'gcMaxPercent']) ui[key] = finite(ui[key], key);
  if (ui.tmToleranceC < 0) throw new Error('tmToleranceC cannot be negative.');
  const primer3 = normalizePrimer3Parameters({
    numReturn: ui.numReturn,
    primerLengthMin: ui.primerLengthMin,
    primerLengthOpt: ui.primerLengthOpt,
    primerLengthMax: ui.primerLengthMax,
    tmMinC: ui.tmTargetC - ui.tmToleranceC,
    tmOptC: ui.tmTargetC,
    tmMaxC: ui.tmTargetC + ui.tmToleranceC,
    productSizeMin: ui.productSizeMin,
    productSizeMax: ui.productSizeMax,
    gcMinPercent: ui.gcMinPercent,
    gcMaxPercent: ui.gcMaxPercent,
    explain: true,
  });
  return { ui, primer3 };
}

function normalizeRecords(records) {
  if (!Array.isArray(records) || !records.length || records.length > 20) {
    throw new Error('Primer3 requires between 1 and 20 records.');
  }
  const seen = new Set();
  return records.map((record) => {
    const sequenceId = safeId(record.sequenceId, 'sequenceId');
    if (seen.has(sequenceId)) throw new Error(`Duplicate sequenceId: ${sequenceId}`);
    seen.add(sequenceId);
    const template = String(record.template ?? record.sequence ?? '').replace(/U/gi, 'T').toUpperCase();
    if (!template || !DNA.test(template)) throw new Error(`${sequenceId} contains an invalid or empty template.`);
    return { sequenceId, template };
  });
}

export function buildPrimer3Input(records, parameters = {}) {
  const normalizedRecords = normalizeRecords(records);
  const p = normalizePrimer3Parameters(parameters);
  return `${normalizedRecords.map((record) => [
    `SEQUENCE_ID=${record.sequenceId}`,
    `SEQUENCE_TEMPLATE=${record.template}`,
    'PRIMER_TASK=generic',
    'PRIMER_PICK_LEFT_PRIMER=1',
    'PRIMER_PICK_INTERNAL_OLIGO=0',
    'PRIMER_PICK_RIGHT_PRIMER=1',
    `PRIMER_NUM_RETURN=${p.numReturn}`,
    `PRIMER_MIN_SIZE=${p.primerLengthMin}`,
    `PRIMER_OPT_SIZE=${p.primerLengthOpt}`,
    `PRIMER_MAX_SIZE=${p.primerLengthMax}`,
    `PRIMER_MIN_TM=${p.tmMinC}`,
    `PRIMER_OPT_TM=${p.tmOptC}`,
    `PRIMER_MAX_TM=${p.tmMaxC}`,
    `PRIMER_MIN_GC=${p.gcMinPercent}`,
    `PRIMER_MAX_GC=${p.gcMaxPercent}`,
    `PRIMER_PRODUCT_SIZE_RANGE=${p.productSizeMin}-${p.productSizeMax}`,
    `PRIMER_EXPLAIN_FLAG=${p.explain ? 1 : 0}`,
    '=',
  ].join('\n')).join('\n')}\n`;
}

function parseBoulderRecords(text) {
  const source = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const records = [];
  let current = new Map();
  let terminated = false;
  for (const [index, raw] of source.split('\n').entries()) {
    if (raw === '') continue;
    if (raw === '=') {
      if (!current.size) throw new Error(`Empty Boulder record at line ${index + 1}.`);
      records.push(current);
      current = new Map();
      terminated = true;
      continue;
    }
    terminated = false;
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error(`Malformed Boulder line ${index + 1}.`);
    const key = raw.slice(0, separator);
    if (current.has(key)) throw new Error(`Duplicate Boulder key ${key}.`);
    current.set(key, raw.slice(separator + 1));
  }
  if (current.size || !terminated) throw new Error('Primer3 output is missing a final record terminator.');
  return records;
}

function numberValue(map, key, required = false) {
  if (!map.has(key)) {
    if (required) throw new Error(`Primer3 output is missing ${key}.`);
    return null;
  }
  const value = Number(map.get(key));
  if (!Number.isFinite(value)) throw new Error(`Primer3 output has invalid numeric value for ${key}.`);
  return value;
}

function location(map, key, templateLength, side) {
  const value = map.get(key);
  const match = String(value ?? '').match(/^(\d+),(\d+)$/);
  if (!match) throw new Error(`Primer3 output has invalid ${key}.`);
  const coordinate = Number(match[1]);
  const length = Number(match[2]);
  const start0 = side === 'right' ? coordinate - length + 1 : coordinate;
  if (length <= 0 || start0 < 0 || start0 + length > templateLength) throw new Error(`${key} is outside the template.`);
  return side === 'right' ? { rightmostBase0: coordinate, start0, length } : { start0, length };
}

function splitDiagnostic(value) {
  return value ? String(value).split(/\s*;\s*/).filter(Boolean) : [];
}

export function parsePrimer3Output(text, { expectedRecords, maxCandidates = MAX_PRIMER3_CANDIDATES, provenance = {} } = {}) {
  const expected = normalizeRecords(expectedRecords);
  const expectedById = new Map(expected.map((record) => [record.sequenceId, record]));
  const maps = parseBoulderRecords(text);
  if (maps.length !== expected.length) throw new Error(`Primer3 record count mismatch: ${maps.length} != ${expected.length}.`);
  const seen = new Set();
  const records = maps.map((map) => {
    const sequenceId = safeId(map.get('SEQUENCE_ID'), 'Primer3 SEQUENCE_ID');
    const input = expectedById.get(sequenceId);
    if (!input || seen.has(sequenceId)) throw new Error(`Unexpected or duplicate Primer3 SEQUENCE_ID: ${sequenceId}`);
    seen.add(sequenceId);
    const errors = splitDiagnostic(map.get('PRIMER_ERROR'));
    const warnings = splitDiagnostic(map.get('PRIMER_WARNING'));
    const count = integer(map.get('PRIMER_PAIR_NUM_RETURNED') ?? 0, 'PRIMER_PAIR_NUM_RETURNED');
    if (count > maxCandidates) throw new Error(`${sequenceId} returned more than ${maxCandidates} candidate pairs.`);
    if (errors.length && count !== 0) throw new Error(`${sequenceId} reports PRIMER_ERROR together with candidates.`);
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      const prefix = `PRIMER_PAIR_${index}`;
      const leftLocation = location(map, `PRIMER_LEFT_${index}`, input.template.length, 'left');
      const rightLocation = location(map, `PRIMER_RIGHT_${index}`, input.template.length, 'right');
      const forwardSequence = String(map.get(`PRIMER_LEFT_${index}_SEQUENCE`) ?? '').toUpperCase();
      const reverseSequence = String(map.get(`PRIMER_RIGHT_${index}_SEQUENCE`) ?? '').toUpperCase();
      if (!DNA.test(forwardSequence) || forwardSequence.length !== leftLocation.length
        || !DNA.test(reverseSequence) || reverseSequence.length !== rightLocation.length) {
        throw new Error(`${sequenceId} candidate ${index} sequence/length mismatch.`);
      }
      const candidateId = safeId(`${sequenceId}.p3.${String(index + 1).padStart(2, '0')}`, 'candidateId');
      candidates.push({
        candidateId,
        sequenceId,
        engine: 'primer3',
        pairRank: index + 1,
        forwardSequence,
        reverseSequence,
        forwardPosition: leftLocation.start0,
        reversePosition: rightLocation.start0,
        forwardLength: leftLocation.length,
        reverseLength: rightLocation.length,
        forwardTm: numberValue(map, `PRIMER_LEFT_${index}_TM`),
        reverseTm: numberValue(map, `PRIMER_RIGHT_${index}_TM`),
        forwardGc: numberValue(map, `PRIMER_LEFT_${index}_GC_PERCENT`),
        reverseGc: numberValue(map, `PRIMER_RIGHT_${index}_GC_PERCENT`),
        productLength: numberValue(map, `${prefix}_PRODUCT_SIZE`, true),
        pairPenalty: numberValue(map, `${prefix}_PENALTY`),
        pairRating: null,
        primer3: {
          left: leftLocation,
          right: rightLocation,
          complAnyTh: numberValue(map, `${prefix}_COMPL_ANY_TH`),
          complEndTh: numberValue(map, `${prefix}_COMPL_END_TH`),
        },
      });
    }
    return {
      sequenceId,
      status: errors.length ? 'primer3_error' : 'ok',
      errors,
      warnings,
      explain: {
        left: map.get('PRIMER_LEFT_EXPLAIN') ?? null,
        right: map.get('PRIMER_RIGHT_EXPLAIN') ?? null,
        pair: map.get('PRIMER_PAIR_EXPLAIN') ?? null,
      },
      numReturned: count,
      candidates,
      raw: Object.fromEntries(map),
    };
  });
  if (seen.size !== expected.length) throw new Error('Primer3 output is missing an expected sequence ID.');
  return { schemaVersion: 1, records, provenance };
}

export function validatePrimer3ServerConfig(value) {
  const config = value || {};
  const hostAlias = safeId(config.hostAlias, 'SSH host alias');
  const remoteRoot = safeRemotePath(config.remoteRoot, 'remoteRoot');
  const slurmScript = safeRemotePath(config.slurmScript, 'slurmScript');
  const provisionScript = safeRemotePath(config.provisionScript || `${remoteRoot}/jobs/provision-primer3.slurm`, 'provisionScript');
  if (slurmScript !== `${remoteRoot}/jobs/run-primer3.slurm`
    || provisionScript !== `${remoteRoot}/jobs/provision-primer3.slurm`) {
    throw new Error('Primer3 Slurm scripts must use the fixed remoteRoot/jobs paths.');
  }
  const timeoutMs = integer(config.timeoutMs ?? 7_200_000, 'timeoutMs', 1_000);
  if (timeoutMs > 24 * 60 * 60 * 1000) throw new Error('timeoutMs cannot exceed 24 hours.');
  const expectedSourceSha256 = String(config.expectedSourceSha256 || PRIMER3_SOURCE_SHA256).toLowerCase();
  if (!SHA256.test(expectedSourceSha256)) throw new Error('expectedSourceSha256 is invalid.');
  const expectedToolSha256 = config.expectedToolSha256 ? String(config.expectedToolSha256).toLowerCase() : null;
  const expectedConfigTreeSha256 = config.expectedConfigTreeSha256
    ? String(config.expectedConfigTreeSha256).toLowerCase() : null;
  if (expectedToolSha256 && !SHA256.test(expectedToolSha256)) throw new Error('expectedToolSha256 is invalid.');
  if (expectedConfigTreeSha256 && !SHA256.test(expectedConfigTreeSha256)) throw new Error('expectedConfigTreeSha256 is invalid.');
  return {
    hostAlias,
    remoteRoot,
    slurmScript,
    provisionScript,
    timeoutMs,
    sshConfigPath: config.sshConfigPath ? path.win32.resolve(String(config.sshConfigPath)) : null,
    expectedVersion: String(config.expectedVersion || PRIMER3_VERSION),
    expectedSourceSha256,
    expectedToolSha256,
    expectedConfigTreeSha256,
  };
}

function connectionArgs(server) {
  const args = [];
  if (server.sshConfigPath) args.push('-F', server.sshConfigPath);
  args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20');
  return args;
}

export function makePrimer3RemoteRunId(jobId, now = new Date()) {
  const safe = safeId(jobId, 'jobId');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${safe.slice(0, 58)}-p3-${stamp}`;
}

export function buildPrimer3SbatchRemoteArgs({ server, runId, wait = true }) {
  const config = validatePrimer3ServerConfig(server);
  return [
    ...connectionArgs(config), config.hostAlias, 'sbatch', ...(wait ? ['--wait'] : []), '--parsable',
    `--export=ALL,PRIMER3_RUN_ID=${safeId(runId, 'runId')}`,
    config.slurmScript,
  ];
}

export function parsePrimer3CompletedTsv(text) {
  const rows = String(text).split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
  if (!rows.length || rows[0][0] !== 'key' || rows[0][1] !== 'value') throw new Error('Invalid Primer3 completed.tsv header.');
  const result = {};
  for (const row of rows.slice(1)) {
    if (row.length !== 2 || !row[0] || Object.hasOwn(result, row[0])) throw new Error('Invalid or duplicate Primer3 completion key.');
    result[row[0]] = row[1];
  }
  return result;
}

async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function executeSshPrimer3({
  jobDir, jobId, records, parameters, serverConfig, runner = runProcess, now = new Date(),
  onProgress = async () => {},
}) {
  const server = validatePrimer3ServerConfig(serverConfig);
  if (server.sshConfigPath) await access(server.sshConfigPath);
  const runId = makePrimer3RemoteRunId(jobId, now);
  const localRunDir = assertADrive(path.join(jobDir, 'raw', 'server-primer3', runId), 'Primer3 raw output directory');
  await mkdir(path.dirname(localRunDir), { recursive: true });
  await mkdir(localRunDir, { recursive: false });
  const request = buildPrimer3Input(records, parameters);
  const requestPath = path.join(localRunDir, 'request.boulder');
  await writeFile(requestPath, request, 'utf8');
  const requestSha256 = await sha256File(requestPath);
  const remoteRunDir = `${server.remoteRoot}/runs/${runId}`;
  const sshArgs = connectionArgs(server);
  await runner('ssh', [...sshArgs, server.hostAlias, 'mkdir', remoteRunDir], { timeoutMs: 60_000 });
  await runner('scp', [...sshArgs, requestPath, `${server.hostAlias}:${remoteRunDir}/request.boulder`], { timeoutMs: 120_000 });
  const submitted = await runner('ssh', buildPrimer3SbatchRemoteArgs({ server, runId, wait: false }), { timeoutMs: 120_000 });
  const slurmJobId = submitted.stdout.match(/(?:^|\n)(\d+)(?:;[^\n]+)?(?:\n|$)/)?.[1];
  if (!slurmJobId) throw new Error('Primer3 Slurm submission did not return a job ID.');
  await onProgress({ jobId: slurmJobId, state: 'SUBMITTED', elapsedMs: 0, runId, remoteRunDir });
  await waitForSlurmCompletion({
    runner, connection: sshArgs, hostAlias: server.hostAlias, jobId: slurmJobId,
    timeoutMs: server.timeoutMs, onProgress,
  });
  const downloads = ['result.boulder', 'primer3.stderr', 'completed.tsv', 'results-manifest.tsv'];
  for (const name of downloads) {
    await runner('scp', [...sshArgs, `${server.hostAlias}:${remoteRunDir}/${name}`, path.join(localRunDir, name)], { timeoutMs: 120_000 });
  }
  const completed = parsePrimer3CompletedTsv(await readFile(path.join(localRunDir, 'completed.tsv'), 'utf8'));
  if (completed.schemaVersion !== '1' || completed.protocolVersion !== 'primer3-ssh-slurm-v1'
    || completed.runId !== runId || completed.primer3Version !== server.expectedVersion
    || completed.sourceSha256 !== server.expectedSourceSha256
    || completed.inputSha256 !== requestSha256) throw new Error('Primer3 completion provenance does not match the request.');
  if (server.expectedToolSha256 && completed.toolSha256 !== server.expectedToolSha256) {
    throw new Error('Primer3 executable SHA-256 does not match the locally pinned value.');
  }
  if (server.expectedConfigTreeSha256 && completed.configTreeSha256 !== server.expectedConfigTreeSha256) {
    throw new Error('Primer3 thermodynamic configuration hash does not match the locally pinned value.');
  }
  for (const [fileName, hashKey] of [['result.boulder', 'outputSha256'], ['primer3.stderr', 'stderrSha256']]) {
    if (!SHA256.test(completed[hashKey] || '') || await sha256File(path.join(localRunDir, fileName)) !== completed[hashKey]) {
      throw new Error(`Primer3 ${fileName} SHA-256 verification failed.`);
    }
  }
  if (integer(completed.recordCount, 'recordCount') !== records.length) throw new Error('Primer3 record count provenance mismatch.');
  const parsed = parsePrimer3Output(await readFile(path.join(localRunDir, 'result.boulder'), 'utf8'), {
    expectedRecords: records,
    maxCandidates: normalizePrimer3Parameters(parameters).numReturn,
    provenance: { runId, slurmJobId, completed },
  });
  return { runId, remoteRunDir, localRunDir, slurmJobId, requestSha256, completed, parsed };
}
