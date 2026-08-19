import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { assertADrive } from './job.mjs';
import { classifyContig, classifyProducts } from './ucsc.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const PRIMER_SEQUENCE = /^[ACGTRYSWKMBDHVN]+$/;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export const DEFAULT_ISPCR_WEB_PARAMETERS = Object.freeze({
  maxProductSize: 10000,
  parallelism: 4,
});

export const ISPCR_WEB_CONSTRAINTS = Object.freeze({
  minProductSize: 0,
  maxProductSize: Object.freeze({ min: 1000, max: 50000, integer: true }),
  parallelism: Object.freeze({ min: 4, max: 8, integer: true }),
});

export function normalizeIsPcrWebParameters(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('validationParameters must be an object.');
  }
  const allowed = Object.keys(DEFAULT_ISPCR_WEB_PARAMETERS);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`validationParameters contains unknown fields: ${unknown.join(', ')}.`);
  const parameters = { ...DEFAULT_ISPCR_WEB_PARAMETERS, ...value };
  if (typeof parameters.maxProductSize !== 'number'
    || !Number.isInteger(parameters.maxProductSize)
    || parameters.maxProductSize < ISPCR_WEB_CONSTRAINTS.maxProductSize.min
    || parameters.maxProductSize > ISPCR_WEB_CONSTRAINTS.maxProductSize.max) {
    throw new Error(`maxProductSize must be an integer between ${ISPCR_WEB_CONSTRAINTS.maxProductSize.min} and ${ISPCR_WEB_CONSTRAINTS.maxProductSize.max}.`);
  }
  if (typeof parameters.parallelism !== 'number'
    || !Number.isInteger(parameters.parallelism)
    || parameters.parallelism < ISPCR_WEB_CONSTRAINTS.parallelism.min
    || parameters.parallelism > ISPCR_WEB_CONSTRAINTS.parallelism.max) {
    throw new Error(`parallelism must be an integer between ${ISPCR_WEB_CONSTRAINTS.parallelism.min} and ${ISPCR_WEB_CONSTRAINTS.parallelism.max}.`);
  }
  return Object.freeze({
    minProductSize: ISPCR_WEB_CONSTRAINTS.minProductSize,
    maxProductSize: parameters.maxProductSize,
    parallelism: parameters.parallelism,
  });
}

export function resultMatchesIsPcrParameters(result, parameters) {
  const recorded = result?.tool?.parameters;
  if (!recorded) return false;
  return String(recorded.minSize) === String(parameters.minSize)
    && String(recorded.maxSize) === String(parameters.maxSize)
    && String(recorded.minPerfect) === String(parameters.minPerfect)
    && String(recorded.minGood) === String(parameters.minGood)
    && String(recorded.flipReverse) === String(parameters.flipReverse ? 1 : 0);
}

export function buildRoundRobinShardPlan(candidateIds, configuredParallelism = 4) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) throw new Error('候选 ID 列表不能为空。');
  if (!Number.isInteger(configuredParallelism)
    || configuredParallelism < ISPCR_WEB_CONSTRAINTS.parallelism.min
    || configuredParallelism > ISPCR_WEB_CONSTRAINTS.parallelism.max) {
    throw new Error('parallelism 必须是 4–8 的整数。');
  }
  const seen = new Set();
  const ids = candidateIds.map((value) => {
    const id = assertSafeId(value, '候选 ID');
    if (seen.has(id)) throw new Error(`候选 ID 重复: ${id}`);
    seen.add(id);
    return id;
  });
  const actualParallelism = Math.min(configuredParallelism, ids.length);
  const shards = Array.from({ length: actualParallelism }, () => []);
  ids.forEach((id, index) => shards[index % actualParallelism].push(id));
  return Object.freeze({
    configuredParallelism,
    actualParallelism,
    strategy: 'round_robin_v1',
    shards: Object.freeze(shards.map((shard) => Object.freeze(shard))),
  });
}

function optionalSha256(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} 必须是 SHA-256。`);
  return normalized;
}

function assertSafeId(value, label) {
  const normalized = String(value ?? '');
  if (!SAFE_ID.test(normalized)) throw new Error(`${label}包含不安全字符: ${normalized}`);
  return normalized;
}

function assertInteger(value, label, minimum = 0) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum) {
    throw new Error(`${label}必须是大于等于 ${minimum} 的整数。`);
  }
  return normalized;
}

function assertRemotePath(value, label) {
  const normalized = String(value ?? '');
  if (!SAFE_REMOTE_PATH.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label}必须是无空格、无 .. 的绝对 POSIX 路径。`);
  }
  return normalized.replace(/\/$/, '');
}

export function buildIsPcrQuery(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('isPcr 至少需要一对候选引物。');
  }
  const seen = new Set();
  const rows = candidates.map((candidate) => {
    const candidateId = assertSafeId(candidate.candidateId, '候选 ID');
    if (seen.has(candidateId)) throw new Error(`候选 ID 重复: ${candidateId}`);
    seen.add(candidateId);
    const forward = String(candidate.forwardSequence ?? '').toUpperCase();
    const reverse = String(candidate.reverseSequence ?? '').toUpperCase();
    if (!PRIMER_SEQUENCE.test(forward) || !PRIMER_SEQUENCE.test(reverse)) {
      throw new Error(`${candidateId} 包含 isPcr 不支持的引物字符。`);
    }
    if (forward.length < 11 || reverse.length < 11) {
      throw new Error(`${candidateId} 的引物短于 isPcr 最低 11 bp。`);
    }
    return `${candidateId}\t${forward}\t${reverse}`;
  });
  return `${rows.join('\n')}\n`;
}

export function buildBlatPrimerFasta(candidates) {
  buildIsPcrQuery(candidates);
  return `${candidates.flatMap((candidate) => [
    `>${candidate.candidateId}_forward`,
    String(candidate.forwardSequence).toUpperCase(),
    `>${candidate.candidateId}_reverse`,
    String(candidate.reverseSequence).toUpperCase(),
  ]).join('\n')}\n`;
}

export function parseIsPcrBed(text, { candidates, assembly, provenance = {} }) {
  const assemblyId = assertSafeId(assembly, '组装 ID');
  const candidateMap = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const productsByCandidate = new Map(candidates.map((candidate) => [candidate.candidateId, []]));
  const dedupe = new Set();

  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    if (!rawLine.trim() || rawLine.startsWith('#')) continue;
    const fields = rawLine.split('\t');
    if (fields.length < 6) throw new Error(`${assemblyId} BED 第 ${index + 1} 行少于 6 列。`);
    const [contig, startToken, endToken, candidateId, scoreToken, strand] = fields;
    const candidate = candidateMap.get(candidateId);
    if (!candidate) throw new Error(`${assemblyId} BED 包含未知候选 ID: ${candidateId}`);
    const start0 = Number(startToken);
    const end0 = Number(endToken);
    if (!Number.isInteger(start0) || !Number.isInteger(end0) || start0 < 0 || end0 <= start0) {
      throw new Error(`${assemblyId} BED 第 ${index + 1} 行坐标无效。`);
    }
    if (strand !== '+' && strand !== '-') {
      throw new Error(`${assemblyId} BED 第 ${index + 1} 行链方向无效: ${strand}`);
    }
    const key = `${candidateId}\t${contig}\t${start0}\t${end0}\t${strand}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const score = Number(scoreToken);
    productsByCandidate.get(candidateId).push({
      contig,
      contigClass: classifyContig(contig),
      start0,
      end0,
      start1: start0 + 1,
      end1: end0,
      strand,
      productSize: end0 - start0,
      score: Number.isFinite(score) ? score : scoreToken,
      forwardSequence: candidate.forwardSequence,
      reverseSequence: candidate.reverseSequence,
      rawRecord: rawLine,
    });
  }

  return Object.fromEntries(candidates.map((candidate) => {
    const products = productsByCandidate.get(candidate.candidateId)
      .sort((left, right) => left.contig.localeCompare(right.contig)
        || left.start0 - right.start0 || left.end0 - right.end0 || left.strand.localeCompare(right.strand));
    return [candidate.candidateId, {
      status: 'ok',
      classification: classifyProducts(products),
      products,
      warnings: [],
      candidateId: candidate.candidateId,
      assembly: assemblyId,
      source: 'server_isPcr',
      tool: {
        name: 'UCSC isPcr',
        execution: 'ssh_slurm',
        ...provenance,
      },
    }];
  }));
}

export function parseBlatPsl(text, { candidates, assembly }) {
  const assemblyId = assertSafeId(assembly, '组装 ID');
  const candidateMap = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const alignments = new Map(candidates.map((candidate) => [candidate.candidateId, { forward: [], reverse: [] }]));
  const numericColumns = [
    'matches', 'misMatches', 'repMatches', 'nCount', 'qNumInsert', 'qBaseInsert',
    'tNumInsert', 'tBaseInsert', 'qSize', 'qStart', 'qEnd', 'tSize', 'tStart0',
    'tEnd0', 'blockCount',
  ];

  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    if (!rawLine.trim() || rawLine.startsWith('#')) continue;
    const fields = rawLine.split('\t');
    if (fields.length !== 21) throw new Error(`${assemblyId} PSL 第 ${index + 1} 行不是 21 列。`);
    const queryMatch = fields[9].match(/^(.*)_(forward|reverse)$/);
    if (!queryMatch || !candidateMap.has(queryMatch[1])) {
      throw new Error(`${assemblyId} PSL 包含未知 query: ${fields[9]}`);
    }
    const candidateId = queryMatch[1];
    const primerRole = queryMatch[2];
    const numericValues = [
      ...fields.slice(0, 8),
      ...fields.slice(10, 13),
      ...fields.slice(14, 18),
    ].map(Number);
    if (numericValues.some((value) => !Number.isInteger(value) || value < 0)) {
      throw new Error(`${assemblyId} PSL 第 ${index + 1} 行包含无效数值。`);
    }
    const numeric = Object.fromEntries(numericColumns.map((key, column) => [key, numericValues[column]]));
    if (numeric.qStart > numeric.qEnd || numeric.qEnd > numeric.qSize
      || numeric.tStart0 > numeric.tEnd0 || numeric.tEnd0 > numeric.tSize) {
      throw new Error(`${assemblyId} PSL 第 ${index + 1} 行坐标范围无效。`);
    }
    const candidate = candidateMap.get(candidateId);
    const expectedQuerySize = String(primerRole === 'forward'
      ? candidate.forwardSequence : candidate.reverseSequence).length;
    if (numeric.qSize !== expectedQuerySize) {
      throw new Error(`${assemblyId} PSL 第 ${index + 1} 行的 query 长度与候选引物不一致。`);
    }
    if (fields[8] !== '+' && fields[8] !== '-') {
      throw new Error(`${assemblyId} PSL 第 ${index + 1} 行链方向无效: ${fields[8]}`);
    }
    const denominator = numeric.matches + numeric.misMatches + numeric.repMatches;
    alignments.get(candidateId)[primerRole].push({
      ...numeric,
      strand: fields[8],
      qName: fields[9],
      tName: fields[13],
      tStart1: numeric.tStart0 + 1,
      tEnd1: numeric.tEnd0,
      blockSizes: fields[18],
      qStarts: fields[19],
      tStarts: fields[20],
      queryCoverage: numeric.qSize ? (numeric.qEnd - numeric.qStart) / numeric.qSize : 0,
      identity: denominator ? numeric.matches / denominator : 0,
      fullLengthExact: numeric.qStart === 0 && numeric.qEnd === numeric.qSize
        && numeric.misMatches === 0 && numeric.nCount === 0
        && numeric.qNumInsert === 0 && numeric.tNumInsert === 0,
      contigClass: classifyContig(fields[13]),
      rawRecord: rawLine,
    });
  }

  return Object.fromEntries(candidates.map((candidate) => {
    const primerAlignments = alignments.get(candidate.candidateId);
    for (const role of ['forward', 'reverse']) {
      primerAlignments[role].sort((left, right) => left.tName.localeCompare(right.tName)
        || left.tStart0 - right.tStart0 || left.tEnd0 - right.tEnd0);
    }
    return [candidate.candidateId, {
      primerAlignments,
      blatSummary: {
        forwardHits: primerAlignments.forward.length,
        reverseHits: primerAlignments.reverse.length,
        forwardFullLengthExact: primerAlignments.forward.filter((item) => item.fullLengthExact).length,
        reverseFullLengthExact: primerAlignments.reverse.filter((item) => item.fullLengthExact).length,
      },
    }];
  }));
}

export function parseKeyValueTsv(text) {
  const rows = String(text).split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split('\t'));
  if (!rows.length || rows[0][0] !== 'key' || rows[0][1] !== 'value') {
    throw new Error('completed.tsv 表头无效。');
  }
  const result = {};
  for (const [index, row] of rows.slice(1).entries()) {
    if (row.length !== 2 || !row[0]) throw new Error(`completed.tsv 第 ${index + 2} 行无效。`);
    if (Object.hasOwn(result, row[0])) throw new Error(`completed.tsv 键重复: ${row[0]}`);
    result[row[0]] = row[1];
  }
  return result;
}

export function parseResultManifest(text) {
  const rows = String(text).split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split('\t'));
  const legacyHeader = [
    'assembly', 'database', 'database_sha256',
    'ispcr_result', 'ispcr_sha256', 'ispcr_hit_count',
    'blat_result', 'blat_sha256', 'blat_alignment_count',
  ];
  const currentHeader = [...legacyHeader, 'blat_status', 'blat_review_candidate_count'];
  const expectedHeader = rows[0]?.length === currentHeader.length ? currentHeader : legacyHeader;
  if (!rows.length || rows[0].length !== expectedHeader.length
    || rows[0].some((value, index) => value !== expectedHeader[index])) {
    throw new Error('results-manifest.tsv 表头无效。');
  }
  const result = new Map();
  for (const [index, row] of rows.slice(1).entries()) {
    if (row.length !== expectedHeader.length) throw new Error(`结果清单第 ${index + 2} 行列数无效。`);
    const entry = Object.fromEntries(expectedHeader.map((key, column) => [key, row[column]]));
    assertSafeId(entry.assembly, '结果清单组装 ID');
    if (result.has(entry.assembly)) throw new Error(`结果清单组装重复: ${entry.assembly}`);
    if (!/^[a-f0-9]{64}$/i.test(entry.database_sha256)
      || !/^[a-f0-9]{64}$/i.test(entry.ispcr_sha256)
      || !/^[a-f0-9]{64}$/i.test(entry.blat_sha256)) {
      throw new Error(`结果清单 ${entry.assembly} 的 SHA-256 无效。`);
    }
    entry.ispcr_hit_count = assertInteger(entry.ispcr_hit_count, `${entry.assembly} ispcr_hit_count`);
    entry.blat_alignment_count = assertInteger(entry.blat_alignment_count, `${entry.assembly} blat_alignment_count`);
    if (expectedHeader === legacyHeader) {
      entry.blat_status = 'legacy_all_candidates';
      entry.blat_review_candidate_count = null;
    } else {
      if (!['reviewed_suspicious_only', 'skipped_all_unique_primary'].includes(entry.blat_status)) {
        throw new Error(`结果清单 ${entry.assembly} 的 BLAT 状态无效。`);
      }
      entry.blat_review_candidate_count = assertInteger(
        entry.blat_review_candidate_count, `${entry.assembly} blat_review_candidate_count`,
      );
    }
    result.set(entry.assembly, entry);
  }
  return result;
}

export function validateIsPcrServerConfig(value) {
  const config = value || {};
  const hostAlias = assertSafeId(config.hostAlias, 'SSH host alias');
  const remoteRoot = assertRemotePath(config.remoteRoot, 'remoteRoot');
  const slurmScript = assertRemotePath(config.slurmScript, 'slurmScript');
  if (!slurmScript.startsWith(`${remoteRoot}/jobs/`)) {
    throw new Error('slurmScript 必须位于 remoteRoot/jobs 下。');
  }
  const sshConfigPath = config.sshConfigPath ? path.win32.resolve(String(config.sshConfigPath)) : null;
  const timeoutMs = assertInteger(config.timeoutMs ?? 7_200_000, 'timeoutMs', 1_000);
  if (timeoutMs > 24 * 60 * 60 * 1000) throw new Error('timeoutMs 不能超过 24 小时。');
  const supportedAssemblies = [...new Set((config.supportedAssemblies || []).map((item) => assertSafeId(item, '组装 ID')))];
  if (!supportedAssemblies.length) throw new Error('isPcrServer.supportedAssemblies 不能为空。');
  const expectedDatabaseSha256 = Object.fromEntries(Object.entries(config.expectedDatabaseSha256 || {}).map(([assembly, hash]) => [
    assertSafeId(assembly, '数据库 assembly'), optionalSha256(hash, `${assembly} database hash`),
  ]));
  const progressProtocol = config.progressProtocol || null;
  if (progressProtocol !== null && progressProtocol !== 'parallel_v1') {
    throw new Error('isPcrServer.progressProtocol 无效。');
  }
  return {
    hostAlias, remoteRoot, slurmScript, sshConfigPath, timeoutMs, supportedAssemblies,
    progressProtocol,
    expectedIsPcrSha256: optionalSha256(config.expectedIsPcrSha256, 'isPcr hash'),
    expectedBlatSha256: optionalSha256(config.expectedBlatSha256, 'BLAT hash'),
    expectedProvisionManifestSha256: optionalSha256(config.expectedProvisionManifestSha256, 'provision manifest hash'),
    expectedRunScriptSha256: optionalSha256(config.expectedRunScriptSha256, 'run script hash'),
    expectedDatabaseSha256,
  };
}

export function makeRemoteRunId(jobId, now = new Date()) {
  const safeJobId = assertSafeId(jobId, '任务 ID');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = `-${stamp}`;
  const maximumJobLength = 128 - suffix.length;
  return `${safeJobId.slice(0, maximumJobLength)}${suffix}`;
}

function connectionArgs(server) {
  const args = [];
  if (server.sshConfigPath) args.push('-F', server.sshConfigPath);
  args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20');
  return args;
}

function requestedAssemblyList(assemblies, server) {
  if (!Array.isArray(assemblies) || assemblies.length === 0) {
    throw new Error('至少需要一个待检查组装。');
  }
  const normalized = assemblies.map((item) => assertSafeId(item, '组装 ID'));
  if (new Set(normalized).size !== normalized.length) throw new Error('待检查组装不能重复。');
  const unsupported = normalized.filter((item) => !server.supportedAssemblies.includes(item));
  if (unsupported.length) {
    throw new Error(`服务器不支持组装: ${unsupported.join(', ')}。`);
  }
  return normalized;
}

export function buildSbatchRemoteArgs({ server, runId, assemblies, parameters, wait = true }) {
  const requestedAssemblies = requestedAssemblyList(assemblies, server);
  const minSize = assertInteger(parameters.minSize, 'minSize');
  const maxSize = assertInteger(parameters.maxSize, 'maxSize');
  if (maxSize < minSize) throw new Error('maxSize 不能小于 minSize。');
  const minPerfect = assertInteger(parameters.minPerfect, 'minPerfect', 1);
  const minGood = assertInteger(parameters.minGood, 'minGood', 1);
  const parallelism = assertInteger(parameters.parallelism ?? DEFAULT_ISPCR_WEB_PARAMETERS.parallelism, 'parallelism', 1);
  if (parallelism < ISPCR_WEB_CONSTRAINTS.parallelism.min || parallelism > ISPCR_WEB_CONSTRAINTS.parallelism.max) {
    throw new Error('parallelism 必须是 4–8 的整数。');
  }
  const flipReverse = parameters.flipReverse ? 1 : 0;
  return [
    ...connectionArgs(server),
    server.hostAlias,
    'sbatch',
    ...(wait ? ['--wait'] : []),
    '--parsable',
    `--export=ALL,PRIME_RUN_ID=${assertSafeId(runId, '远程运行 ID')},PRIME_ASSEMBLIES=${requestedAssemblies.join(',')},PRIME_MIN_SIZE=${minSize},PRIME_MAX_SIZE=${maxSize},PRIME_MIN_PERFECT=${minPerfect},PRIME_MIN_GOOD=${minGood},PRIME_PARALLELISM=${parallelism},PRIME_FLIP_REVERSE=${flipReverse}`,
    server.slurmScript,
  ];
}

const SLURM_FAILURE_STATES = new Set([
  'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE',
]);

const REMOTE_PROGRESS_PHASES = new Set([
  'database_check', 'ispcr', 'blat', 'packaging', 'complete', 'failed',
]);

export const REMOTE_PROGRESS_ERROR_LABELS = Object.freeze({
  preflight_missing_dependency: '服务器缺少验证输入、工具或部署清单',
  completed_output_exists: '服务器运行目录已存在完成结果',
  query_validation_failed: '候选引物查询文件校验失败',
  integrity_check_failed: 'isPCR、BLAT 或基因组数据库完整性校验失败',
  shard_failed: 'isPCR 并行分片运行失败',
  output_validation_failed: '服务器结果文件校验失败',
  remote_job_failed: '服务器验证作业失败',
});

export function parseRemoteProgressStatus(text, expectedRunId) {
  const lines = String(text).split(/\r?\n/);
  const stateLine = lines.find((line) => line.startsWith('slurmState\t'));
  const slurmState = String(stateLine?.split('\t')[1] || 'UNKNOWN').split(/[+\s]/)[0].toUpperCase();
  const begin = lines.indexOf('progressBegin');
  const end = lines.indexOf('progressEnd');
  if (begin < 0 || end <= begin + 1) return { slurmState, progress: null };
  const progress = parseKeyValueTsv(lines.slice(begin + 1, end).join('\n'));
  if (progress.schemaVersion !== '1' || progress.runId !== expectedRunId
    || !REMOTE_PROGRESS_PHASES.has(progress.phase)) {
    throw new Error('远程 progress.tsv 与本次运行不一致。');
  }
  const numericKeys = [
    'candidateTotal', 'candidateCompleted', 'shardTotal', 'shardCompleted', 'activeWorkers',
    'configuredParallelism', 'actualParallelism', 'blatCandidateTotal',
  ];
  const numeric = Object.fromEntries(numericKeys.map((key) => [key, assertInteger(progress[key], key)]));
  if (numeric.candidateCompleted > numeric.candidateTotal
    || numeric.shardCompleted > numeric.shardTotal
    || numeric.actualParallelism > numeric.configuredParallelism) {
    throw new Error('远程 progress.tsv 计数范围无效。');
  }
  const errorCode = progress.errorCode || null;
  if (errorCode !== null && !Object.hasOwn(REMOTE_PROGRESS_ERROR_LABELS, errorCode)) {
    throw new Error('远程 progress.tsv 错误码无效。');
  }
  return {
    slurmState,
    progress: {
      schemaVersion: 1,
      runId: progress.runId,
      phase: progress.phase,
      assembly: assertSafeId(progress.assembly, '进度 assembly'),
      ...numeric,
      errorCode,
      updatedAtUtc: progress.updatedAtUtc || null,
    },
  };
}

async function readRemoteProgressStatus({ runner, server, jobId, runId }) {
  const response = await runner('ssh', [
    ...connectionArgs(server), server.hostAlias, 'bash', server.slurmScript,
    '--status', String(jobId), assertSafeId(runId, '远程运行 ID'),
  ], { timeoutMs: 30_000 });
  return parseRemoteProgressStatus(response.stdout, runId);
}

export async function waitForIsPcrSlurmCompletion({
  runner = runProcess, server, jobId, runId, timeoutMs, onProgress = async () => {}, pollMs = 5_000,
}) {
  const started = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await readRemoteProgressStatus({ runner, server, jobId, runId });
      consecutiveErrors = 0;
      await onProgress({
        jobId: String(jobId), state: status.slurmState || 'UNKNOWN', elapsedMs: Date.now() - started,
        runId, ...(status.progress || {}),
      });
      if (status.slurmState === 'COMPLETED') return { state: 'COMPLETED', elapsedMs: Date.now() - started };
      if (SLURM_FAILURE_STATES.has(status.slurmState)) {
        const detail = status.progress?.errorCode
          ? `：${REMOTE_PROGRESS_ERROR_LABELS[status.progress.errorCode]}` : '';
        const error = new Error(`Slurm 作业 ${jobId} 结束于 ${status.slurmState}${detail}。`);
        error.code = status.progress?.errorCode || 'remote_job_failed';
        throw error;
      }
    } catch (error) {
      if (/结束于/.test(error.message)) throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw new Error(`无法查询 Slurm 作业 ${jobId}：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`等待 Slurm 作业 ${jobId} 超时；作业可能仍在服务器运行。`);
}

export async function waitForSlurmCompletion({
  runner = runProcess, connection = [], hostAlias, jobId, timeoutMs, onProgress = async () => {}, pollMs = 2_000,
}) {
  const started = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - started < timeoutMs) {
    let state = '';
    try {
      const queued = await runner('ssh', [
        ...connection, hostAlias, 'squeue', '-h', '-j', String(jobId), '-o', '%T',
      ], { timeoutMs: 30_000 });
      state = String(queued.stdout || '').trim().split(/\r?\n/)[0] || '';
      if (!state) {
        const accounting = await runner('ssh', [
          ...connection, hostAlias, 'sacct', '-n', '-X', '-j', String(jobId), '-o', 'State', '-P',
        ], { timeoutMs: 30_000 });
        state = String(accounting.stdout || '').trim().split(/\r?\n/).map((line) => line.split('|')[0])
          .find(Boolean) || '';
      }
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw new Error(`无法查询 Slurm 作业 ${jobId}：${error.message}`);
    }
    const normalized = state.split(/[+\s]/)[0].toUpperCase();
    await onProgress({ jobId: String(jobId), state: normalized || 'UNKNOWN', elapsedMs: Date.now() - started });
    if (normalized === 'COMPLETED') return { state: normalized, elapsedMs: Date.now() - started };
    if (SLURM_FAILURE_STATES.has(normalized)) throw new Error(`Slurm 作业 ${jobId} 结束于 ${normalized}。`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`等待 Slurm 作业 ${jobId} 超时；作业可能仍在服务器运行。`);
}

export async function runProcess(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const error = new Error(`${executable} 超时（${timeoutMs} ms）。远程 Slurm 作业可能仍在运行。`);
      error.code = 'PROCESS_TIMEOUT';
      reject(error);
    }, timeoutMs);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const capture = (target, chunk) => {
      const updated = target + chunk.toString('utf8');
      if (Buffer.byteLength(updated, 'utf8') > MAX_CAPTURE_BYTES) {
        child.kill();
        throw new Error(`${executable} 输出超过 ${MAX_CAPTURE_BYTES} bytes，已停止。`);
      }
      return updated;
    };
    child.stdout.on('data', (chunk) => {
      try { stdout = capture(stdout, chunk); } catch (error) { fail(error); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = capture(stderr, chunk); } catch (error) { fail(error); }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ code, signal, stdout, stderr });
      else {
        const detail = stderr.trim() || stdout.trim() || `signal ${signal || 'none'}`;
        const error = new Error(`${executable} 退出码 ${code}: ${detail}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function nonEmptyLineCount(text) {
  return String(text).split(/\r?\n/).filter((line) => line.trim()).length;
}

export async function executeSshIsPcr({
  jobDir,
  jobId,
  candidates,
  assemblies,
  parameters,
  serverConfig,
  runner = runProcess,
  now = new Date(),
  onProgress = async () => {},
}) {
  const server = validateIsPcrServerConfig(serverConfig);
  const requestedAssemblies = requestedAssemblyList(assemblies, server);
  if (requestedAssemblies.length !== 1) throw new Error('并行 isPCR 每个 Slurm 作业只允许一个 assembly。');
  if (server.sshConfigPath) await access(server.sshConfigPath);

  const queryText = buildIsPcrQuery(candidates);
  const querySha256 = createHash('sha256').update(queryText, 'utf8').digest('hex');
  const expectedPrimerFastaSha256 = createHash('sha256')
    .update(buildBlatPrimerFasta(candidates), 'utf8')
    .digest('hex');
  const sshArgs = connectionArgs(server);
  const scpArgs = connectionArgs(server);
  const runRoot = assertADrive(path.join(jobDir, 'raw', 'server-ispcr'), '服务器原始结果目录');
  await mkdir(runRoot, { recursive: true });
  const resumePath = path.join(runRoot, `resume-${assertSafeId(jobId, '任务 ID')}.json`);
  const resumeSignature = JSON.stringify({
    querySha256, assemblies: requestedAssemblies, parameters: {
      minSize: parameters.minSize, maxSize: parameters.maxSize,
      minPerfect: parameters.minPerfect, minGood: parameters.minGood,
      flipReverse: Boolean(parameters.flipReverse),
      parallelism: parameters.parallelism ?? DEFAULT_ISPCR_WEB_PARAMETERS.parallelism,
    },
    runScriptSha256: server.expectedRunScriptSha256,
  });
  let resume = null;
  if (server.progressProtocol === 'parallel_v1') {
    try {
      const parsed = JSON.parse(await readFile(resumePath, 'utf8'));
      if (parsed.signature === resumeSignature && SAFE_ID.test(parsed.runId)
        && /^\d+$/.test(String(parsed.slurmJobId || ''))) resume = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  let runId;
  let localRunDir;
  let remoteRunDir;
  let slurmJobId;
  let knownState = '';
  if (resume) {
    const remote = await readRemoteProgressStatus({
      runner, server, jobId: resume.slurmJobId, runId: resume.runId,
    });
    if (['PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'COMPLETED'].includes(remote.slurmState)) {
      ({ runId, localRunDir, remoteRunDir, slurmJobId } = resume);
      knownState = remote.slurmState;
      await onProgress({
        jobId: slurmJobId, state: knownState, elapsedMs: 0, runId,
        reattached: true, ...(remote.progress || {}),
      });
    }
  }

  if (!slurmJobId) {
    runId = makeRemoteRunId(jobId, now);
    localRunDir = assertADrive(path.join(runRoot, runId), '服务器原始结果目录');
    await mkdir(localRunDir, { recursive: false });
    remoteRunDir = `${server.remoteRoot}/runs/${runId}`;
    const queryPath = path.join(localRunDir, 'queries.tsv');
    await writeFile(queryPath, queryText, 'utf8');
    await runner('ssh', [...sshArgs, server.hostAlias, 'mkdir', remoteRunDir], { timeoutMs: 60_000 });
    await runner('scp', [...scpArgs, queryPath, `${server.hostAlias}:${remoteRunDir}/queries.tsv`], { timeoutMs: 120_000 });
    const submission = await runner('ssh', buildSbatchRemoteArgs({
      server, runId, assemblies: requestedAssemblies, parameters, wait: false,
    }), { timeoutMs: 120_000 });
    const jobMatch = submission.stdout.match(/(?:^|\r?\n)(\d+)(?:;[^\r\n]+)?(?:\r?\n|$)/);
    slurmJobId = jobMatch?.[1] || null;
    if (!slurmJobId) throw new Error('Slurm 提交成功，但未能从输出中确认作业 ID。');
    if (server.progressProtocol === 'parallel_v1') {
      const state = { signature: resumeSignature, runId, localRunDir, remoteRunDir, slurmJobId };
      const resumeTmp = `${resumePath}.tmp`;
      await writeFile(resumeTmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(resumeTmp, resumePath);
    }
    await onProgress({ jobId: slurmJobId, state: 'SUBMITTED', elapsedMs: 0, runId });
  }
  if (knownState !== 'COMPLETED') {
    if (server.progressProtocol === 'parallel_v1') {
      await waitForIsPcrSlurmCompletion({
        runner, server, jobId: slurmJobId, runId,
        timeoutMs: server.timeoutMs, onProgress,
      });
    } else {
      await waitForSlurmCompletion({
        runner, connection: sshArgs, hostAlias: server.hostAlias, jobId: slurmJobId,
        timeoutMs: server.timeoutMs, onProgress,
      });
    }
  }

  const downloads = [
    ['completed.tsv', `${remoteRunDir}/completed.tsv`],
    ['results-manifest.tsv', `${remoteRunDir}/results-manifest.tsv`],
    ['provision-manifest.tsv', `${server.remoteRoot}/provision-manifest.tsv`],
    ['primers.fasta', `${remoteRunDir}/primers.fasta`],
    ...requestedAssemblies.flatMap((assembly) => [
      [`${assembly}.bed`, `${remoteRunDir}/${assembly}.bed`],
      [`${assembly}.psl`, `${remoteRunDir}/${assembly}.psl`],
    ]),
  ];
  downloads.push(
    [`slurm-${slurmJobId}.out`, `${server.remoteRoot}/logs/prime_ispcr_${slurmJobId}.out`],
    [`slurm-${slurmJobId}.err`, `${server.remoteRoot}/logs/prime_ispcr_${slurmJobId}.err`],
  );
  for (const [index, [localName, remotePath]] of downloads.entries()) {
    await onProgress({
      jobId: slurmJobId, state: 'COMPLETED', phase: 'download', runId,
      downloadCompleted: index, downloadTotal: downloads.length,
    });
    await runner('scp', [...scpArgs, `${server.hostAlias}:${remotePath}`, path.join(localRunDir, localName)], {
      timeoutMs: 120_000,
    });
  }
  await onProgress({
    jobId: slurmJobId, state: 'COMPLETED', phase: 'download', runId,
    downloadCompleted: downloads.length, downloadTotal: downloads.length,
  });

  const completed = parseKeyValueTsv(await readFile(path.join(localRunDir, 'completed.tsv'), 'utf8'));
  await onProgress({ jobId: slurmJobId, state: 'COMPLETED', phase: 'verify', runId });
  if (!['1', '2'].includes(completed.schemaVersion) || completed.runId !== runId) throw new Error('远程完成标记与请求不一致。');
  if (completed.assemblies !== requestedAssemblies.join(',')) throw new Error('远程组装集合与请求不一致。');
  if (completed.querySha256 !== querySha256) throw new Error('远程 query SHA-256 与本地上传文件不一致。');
  if (assertInteger(completed.candidateCount, 'candidateCount') !== candidates.length) {
    throw new Error('远程候选数量与本地不一致。');
  }
  if (completed.schemaVersion === '2') {
    const configured = assertInteger(completed.configuredParallelism, 'configuredParallelism');
    const actual = assertInteger(completed.actualParallelism, 'actualParallelism');
    const requested = assertInteger(parameters.parallelism ?? DEFAULT_ISPCR_WEB_PARAMETERS.parallelism, 'parallelism');
    if (configured !== requested || actual !== Math.min(requested, candidates.length)
      || completed.shardStrategy !== 'round_robin_v1'
      || !/^[a-f0-9]{64}$/i.test(completed.shardManifestSha256 || '')) {
      throw new Error('远程并行分片完成标记与请求不一致。');
    }
  }
  for (const key of ['toolSha256', 'blatSha256', 'provisionManifestSha256', 'primersSha256']) {
    if (!/^[a-f0-9]{64}$/i.test(completed[key] || '')) {
      throw new Error(`远程完成标记 ${key} 无效。`);
    }
  }
  if (server.expectedIsPcrSha256 && completed.toolSha256.toLowerCase() !== server.expectedIsPcrSha256) {
    throw new Error('isPcr SHA-256 与本地固定值不一致。');
  }
  if (server.expectedBlatSha256 && completed.blatSha256.toLowerCase() !== server.expectedBlatSha256) {
    throw new Error('BLAT SHA-256 与本地固定值不一致。');
  }
  if (server.expectedProvisionManifestSha256
    && completed.provisionManifestSha256.toLowerCase() !== server.expectedProvisionManifestSha256) {
    throw new Error('UCSC provision manifest SHA-256 与本地固定值不一致。');
  }
  if (server.expectedRunScriptSha256
    && completed.runScriptSha256?.toLowerCase() !== server.expectedRunScriptSha256) {
    throw new Error('isPCR Slurm 脚本 SHA-256 与本地固定值不一致。');
  }
  const downloadedPrimerFastaSha256 = await sha256File(path.join(localRunDir, 'primers.fasta'));
  if (downloadedPrimerFastaSha256 !== completed.primersSha256.toLowerCase()
    || downloadedPrimerFastaSha256 !== expectedPrimerFastaSha256) {
    throw new Error('远程 primer FASTA SHA-256 校验失败。');
  }
  if (await sha256File(path.join(localRunDir, 'provision-manifest.tsv'))
    !== completed.provisionManifestSha256.toLowerCase()) {
    throw new Error('远程 provision manifest SHA-256 校验失败。');
  }
  const expectedParameters = {
    minSize: String(assertInteger(parameters.minSize, 'minSize')),
    maxSize: String(assertInteger(parameters.maxSize, 'maxSize')),
    minPerfect: String(assertInteger(parameters.minPerfect, 'minPerfect', 1)),
    minGood: String(assertInteger(parameters.minGood, 'minGood', 1)),
    flipReverse: parameters.flipReverse ? '1' : '0',
  };
  for (const [key, value] of Object.entries(expectedParameters)) {
    if (completed[key] !== value) throw new Error(`远程参数 ${key} 与请求不一致。`);
  }
  const expectedBlatParameters = {
    blatTileSize: '9',
    blatStepSize: '4',
    blatRepMatch: '16384',
    blatMinScore: '15',
    blatMinIdentity: '0',
  };
  for (const [key, value] of Object.entries(expectedBlatParameters)) {
    if (completed[key] !== value) throw new Error(`远程 BLAT 参数 ${key} 与预期不一致。`);
  }

  const manifest = parseResultManifest(await readFile(path.join(localRunDir, 'results-manifest.tsv'), 'utf8'));
  if (manifest.size !== requestedAssemblies.length) throw new Error('远程结果清单组装数量不一致。');
  const results = {};
  for (const assembly of requestedAssemblies) {
    const entry = manifest.get(assembly);
    if (!entry) throw new Error(`远程结果清单缺少 ${assembly}。`);
    if (server.expectedDatabaseSha256[assembly]
      && entry.database_sha256.toLowerCase() !== server.expectedDatabaseSha256[assembly]) {
      throw new Error(`${assembly} 数据库 SHA-256 与本地固定值不一致。`);
    }
    if (entry.database !== `${server.remoteRoot}/genomes/${assembly}.2bit`
      || entry.ispcr_result !== `${remoteRunDir}/${assembly}.bed`
      || entry.blat_result !== `${remoteRunDir}/${assembly}.psl`) {
      throw new Error(`${assembly} 远程结果清单路径与本次请求不一致。`);
    }
    const bedPath = path.join(localRunDir, `${assembly}.bed`);
    if (await sha256File(bedPath) !== entry.ispcr_sha256.toLowerCase()) {
      throw new Error(`${assembly} BED SHA-256 校验失败。`);
    }
    const pslPath = path.join(localRunDir, `${assembly}.psl`);
    if (await sha256File(pslPath) !== entry.blat_sha256.toLowerCase()) {
      throw new Error(`${assembly} PSL SHA-256 校验失败。`);
    }
    const bedText = await readFile(bedPath, 'utf8');
    const pslText = await readFile(pslPath, 'utf8');
    if (nonEmptyLineCount(bedText) !== entry.ispcr_hit_count) {
      throw new Error(`${assembly} BED 记录数与远程清单不一致。`);
    }
    if (nonEmptyLineCount(pslText) !== entry.blat_alignment_count) {
      throw new Error(`${assembly} PSL 记录数与远程清单不一致。`);
    }
    const blat = parseBlatPsl(pslText, { candidates, assembly });
    const parsed = parseIsPcrBed(bedText, {
      candidates,
      assembly,
      provenance: {
        hostAlias: server.hostAlias,
        remoteRunId: runId,
        slurmJobId,
        completedAt: completed.completedAtUtc,
        toolSha256: completed.toolSha256,
        isPcrSha256: completed.toolSha256,
        blatSha256: completed.blatSha256,
        provisionManifestSha256: completed.provisionManifestSha256,
        runScriptSha256: completed.runScriptSha256 || null,
        primersSha256: completed.primersSha256,
        databaseSha256: entry.database_sha256.toLowerCase(),
        parameters: expectedParameters,
        blatParameters: expectedBlatParameters,
      },
    });
    for (const result of Object.values(parsed)) {
      if (result.products.some((product) => product.productSize < Number(expectedParameters.minSize)
        || product.productSize > Number(expectedParameters.maxSize))) {
        throw new Error(`${assembly} BED 含有超出请求产物长度范围的记录。`);
      }
    }
    for (const [candidateId, result] of Object.entries(parsed)) {
      result.primerAlignments = blat[candidateId].primerAlignments;
      result.blatSummary = blat[candidateId].blatSummary;
      result.blatReviewStatus = entry.blat_status === 'skipped_all_unique_primary'
        || (entry.blat_status === 'reviewed_suspicious_only' && result.classification === 'pass_single_product')
        ? 'not_needed_unique_primary' : entry.blat_status;
      result.importedAt = new Date().toISOString();
      result.sourcePath = `${server.hostAlias}:${entry.ispcr_result}`;
      result.preservedRawPath = bedPath;
      result.blatSourcePath = `${server.hostAlias}:${entry.blat_result}`;
      result.preservedBlatPath = pslPath;
    }
    results[assembly] = parsed;
  }

  return {
    runId,
    remoteRunDir,
    localRunDir,
    slurmJobId,
    querySha256,
    completed,
    manifest: Object.fromEntries(manifest),
    results,
  };
}
