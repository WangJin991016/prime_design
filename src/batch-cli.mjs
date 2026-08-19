import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ALLOWED_ASSEMBLIES,
  buildBatch,
  createCheckpoint,
  previewMultiFasta,
  transitionCheckpoint,
  validateCheckpoint,
} from './lib/batch.mjs';
import {
  executeSshPrimer3,
  normalizePrimer3WebParameters,
  PRIMER3_SOURCE_COMMIT,
  PRIMER3_SOURCE_SHA256,
  validatePrimer3ServerConfig,
} from './lib/primer3.mjs';
import {
  DEFAULT_ISPCR_WEB_PARAMETERS,
  executeSshIsPcr,
  normalizeIsPcrWebParameters,
  resultMatchesIsPcrParameters,
  runProcess,
} from './lib/ispcr.mjs';
import { assertADrive, makeRunName, readJson, writeJson, writeText } from './lib/job.mjs';
import { renderBatchCsv, renderBatchReport } from './lib/batch-report.mjs';

async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function required(options, key) {
  if (!options[key] || options[key] === true) throw new Error(`Missing --${key}.`);
  return options[key];
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function loadBundle(batchDirectory) {
  const batchDir = assertADrive(path.resolve(batchDirectory), 'Batch directory');
  const [batch, checkpoint, config] = await Promise.all([
    readJson(path.join(batchDir, 'batch.json')),
    readJson(path.join(batchDir, 'checkpoint.json')),
    readJson(path.join(batchDir, 'config.json')),
  ]);
  validateCheckpoint(checkpoint, batch);
  return { batchDir, batch, checkpoint, config };
}

export const BROKEN_ISPCR_RUN_SCRIPT_SHA256 = '81e79ef45395f1821a53276aa247322f562ada6dfc8dacb0572beb2250a94ada';

function validSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

export function buildKnownBrokenIsPcrExecutionUpgrade({ batch, config, currentConfig }) {
  const frozen = config?.ucsc?.isPcrServer;
  if (batch?.status !== 'retryable_error'
    || frozen?.expectedRunScriptSha256?.toLowerCase() !== BROKEN_ISPCR_RUN_SCRIPT_SHA256) return null;
  const current = currentConfig?.ucsc?.isPcrServer;
  const safeIdentity = current
    && frozen.hostAlias === current.hostAlias
    && frozen.remoteRoot === current.remoteRoot
    && frozen.slurmScript === current.slurmScript
    && frozen.progressProtocol === 'parallel_v1'
    && current.progressProtocol === 'parallel_v1';
  if (!safeIdentity || !validSha256(current.expectedRunScriptSha256)
    || current.expectedRunScriptSha256.toLowerCase() === BROKEN_ISPCR_RUN_SCRIPT_SHA256) {
    throw new Error('当前批次使用已知故障的 isPCR 脚本，但无法从当前配置安全升级。');
  }
  const updatedConfig = structuredClone(config);
  updatedConfig.ucsc.isPcrServer = {
    ...updatedConfig.ucsc.isPcrServer,
    slurmScript: current.slurmScript,
    progressProtocol: current.progressProtocol,
    expectedRunScriptSha256: current.expectedRunScriptSha256.toLowerCase(),
  };
  return {
    updatedConfig,
    fromHash: BROKEN_ISPCR_RUN_SCRIPT_SHA256,
    toHash: current.expectedRunScriptSha256.toLowerCase(),
    changedFields: [
      'ucsc.isPcrServer.slurmScript',
      'ucsc.isPcrServer.progressProtocol',
      'ucsc.isPcrServer.expectedRunScriptSha256',
    ],
  };
}

export async function upgradeKnownBrokenIsPcrExecution(batchDirectory, currentConfig, now = new Date()) {
  if (!currentConfig) return null;
  const batchDir = assertADrive(path.resolve(batchDirectory), 'Batch directory');
  const [batch, config] = await Promise.all([
    readJson(path.join(batchDir, 'batch.json')),
    readJson(path.join(batchDir, 'config.json')),
  ]);
  const upgrade = buildKnownBrokenIsPcrExecutionUpgrade({ batch, config, currentConfig });
  if (!upgrade) return null;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const auditDir = assertADrive(path.join(
    batchDir, 'raw', 'execution-upgrades',
    `${stamp}-${upgrade.fromHash.slice(0, 8)}-to-${upgrade.toHash.slice(0, 8)}`,
  ), '执行配置升级审计目录');
  await mkdir(path.dirname(auditDir), { recursive: true });
  await mkdir(auditDir, { recursive: false });
  const archivedFiles = [];
  for (const name of ['config.json', 'batch.json']) {
    await copyFile(path.join(batchDir, name), path.join(auditDir, name));
    archivedFiles.push(name);
  }
  const resumeRoot = path.join(batchDir, 'raw', 'server-ispcr');
  try {
    const entries = await readdir(resumeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^resume-[A-Za-z0-9._-]+\.json$/.test(entry.name)) continue;
      await copyFile(path.join(resumeRoot, entry.name), path.join(auditDir, entry.name));
      archivedFiles.push(entry.name);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const upgradedAt = now.toISOString();
  const audit = {
    schemaVersion: 1,
    reason: 'ispcr_query_validator_hotfix_0.5.1',
    upgradedAt,
    fromRunScriptSha256: upgrade.fromHash,
    toRunScriptSha256: upgrade.toHash,
    changedFields: upgrade.changedFields,
    archivedFiles,
    failedJobId: batch.run?.jobId || null,
    failedRunId: batch.run?.runId || null,
  };
  await writeJson(path.join(auditDir, 'upgrade-audit.json'), audit);
  await writeJson(path.join(batchDir, 'config.json'), upgrade.updatedConfig);
  batch.executionUpgrades = [...(batch.executionUpgrades || []), audit];
  batch.updatedAt = upgradedAt;
  await writeJson(path.join(batchDir, 'batch.json'), batch);
  return { auditDir, audit };
}

async function readCandidates(batchDir) {
  try { return (await readJson(path.join(batchDir, 'candidates.json'))).candidates || []; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function readResults(batchDir) {
  try { return (await readJson(path.join(batchDir, 'ucsc-results.json'))).results || {}; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function validationCacheDescriptor(candidate, assembly, parameters, serverConfig = {}) {
  const databaseSha256 = serverConfig.expectedDatabaseSha256?.[assembly];
  const requiredHashes = [
    serverConfig.expectedIsPcrSha256,
    serverConfig.expectedBlatSha256,
    serverConfig.expectedProvisionManifestSha256,
    serverConfig.expectedRunScriptSha256,
    databaseSha256,
  ];
  if (requiredHashes.some((value) => !/^[a-f0-9]{64}$/i.test(String(value || '')))) return null;
  return {
    schemaVersion: 1,
    assembly,
    forwardSequence: String(candidate.forwardSequence).toUpperCase(),
    reverseSequence: String(candidate.reverseSequence).toUpperCase(),
    parameters: {
      minSize: Number(parameters.minSize), maxSize: Number(parameters.maxSize),
      minPerfect: Number(parameters.minPerfect), minGood: Number(parameters.minGood),
      flipReverse: Boolean(parameters.flipReverse),
    },
    tools: {
      isPcrSha256: String(serverConfig.expectedIsPcrSha256).toLowerCase(),
      blatSha256: String(serverConfig.expectedBlatSha256).toLowerCase(),
      provisionManifestSha256: String(serverConfig.expectedProvisionManifestSha256).toLowerCase(),
      runScriptSha256: String(serverConfig.expectedRunScriptSha256).toLowerCase(),
      databaseSha256: String(databaseSha256).toLowerCase(),
      blatParameters: { tileSize: 9, stepSize: 4, repMatch: 16384, minScore: 15, minIdentity: 0 },
      reviewMode: 'suspicious_only_v1',
    },
  };
}

export function validationCacheKey(descriptor) {
  return descriptor ? createHash('sha256').update(JSON.stringify(descriptor)).digest('hex') : null;
}

function validationCacheRoot(batchDir) {
  return path.join(path.dirname(path.dirname(batchDir)), 'cache', 'validation');
}

async function readValidationCache(batchDir, candidate, assembly, parameters, serverConfig) {
  const descriptor = validationCacheDescriptor(candidate, assembly, parameters, serverConfig);
  const cacheKey = validationCacheKey(descriptor);
  if (!cacheKey) return null;
  try {
    const document = await readJson(path.join(validationCacheRoot(batchDir), `${cacheKey}.json`));
    if (document.schemaVersion !== 1 || document.cacheKey !== cacheKey
      || JSON.stringify(document.descriptor) !== JSON.stringify(descriptor)
      || !document.result || document.result.assembly !== assembly
      || document.result.tool?.isPcrSha256 !== descriptor.tools.isPcrSha256
      || document.result.tool?.blatSha256 !== descriptor.tools.blatSha256
      || document.result.tool?.databaseSha256 !== descriptor.tools.databaseSha256
      || !resultMatchesIsPcrParameters(document.result, parameters)) return null;
    const result = structuredClone(document.result);
    result.candidateId = candidate.candidateId;
    result.cache = { hit: true, cacheKey, sourceCreatedAt: document.createdAt };
    result.importedAt = new Date().toISOString();
    return result;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeValidationCache(batchDir, candidate, assembly, parameters, serverConfig, result) {
  const descriptor = validationCacheDescriptor(candidate, assembly, parameters, serverConfig);
  const cacheKey = validationCacheKey(descriptor);
  if (!cacheKey) return;
  await writeJson(path.join(validationCacheRoot(batchDir), `${cacheKey}.json`), {
    schemaVersion: 1, cacheKey, descriptor, createdAt: new Date().toISOString(), result,
  });
}

async function writeReports(batchDir, batch, candidates, results = {}, config = null) {
  await writeText(path.join(batchDir, 'summary.csv'), renderBatchCsv({ batch, candidates, results }));
  await writeText(path.join(batchDir, 'report.html'), renderBatchReport({ batch, candidates, results, config }));
}

async function persistPreparedBatch({
  parsed, fastaText, manifestText, displayNames = {}, name, out, config, designSettings = null,
}, context) {
  const defaultOut = path.join(context.projectRoot, 'batches', makeRunName(name));
  const batchDir = assertADrive(out ? path.resolve(out) : defaultOut, 'Batch directory');
  if (await exists(batchDir)) throw new Error(`Batch directory already exists; refusing overwrite: ${batchDir}`);
  const createdAt = new Date().toISOString();
  const batch = {
    schemaVersion: 1,
    batchId: path.basename(batchDir),
    name,
    createdAt,
    updatedAt: createdAt,
    status: 'prepared',
    candidateCount: 0,
    batchSha256: parsed.batchSha256,
    ...(designSettings?.assembly ? { assembly: designSettings.assembly } : {}),
    ...(designSettings ? { designSettings } : {}),
    records: parsed.records.map((record) => ({
      ...record,
      displayName: String(displayNames[record.sequenceId] || record.sequenceId),
    })),
  };
  const checkpoint = createCheckpoint(batch);
  await mkdir(path.join(batchDir, 'incoming'), { recursive: true });
  await writeText(path.join(batchDir, 'input.fasta'), fastaText.replace(/\r\n/g, '\n'));
  await writeText(path.join(batchDir, 'manifest.tsv'), `${manifestText.trimEnd()}\n`);
  await writeJson(path.join(batchDir, 'config.json'), config);
  await writeJson(path.join(batchDir, 'batch.json'), batch);
  await writeJson(path.join(batchDir, 'checkpoint.json'), checkpoint);
  await writeReports(batchDir, batch, [], {}, config);
  console.log(`Batch created: ${batchDir}`);
  console.log(`Records: ${batch.records.length}; workflow: Primer3 + server validation.`);
  return batchDir;
}

export async function batchPrepare(options, context) {
  const fastaPath = path.resolve(required(options, 'fasta'));
  const manifestPath = path.resolve(required(options, 'manifest'));
  const [fastaText, manifestText, config] = await Promise.all([
    readFile(fastaPath, 'utf8'), readFile(manifestPath, 'utf8'), context.loadConfig(options.config),
  ]);
  const preview = previewMultiFasta(fastaText);
  if (!preview.valid) throw new Error(preview.errors.map((entry) => entry.message).join(' '));
  const parsed = buildBatch({ fasta: fastaText, manifest: manifestText });
  const name = String(options.name || path.parse(fastaPath).name || 'batch');
  const displayNames = Object.fromEntries(preview.records.map((record) => [record.id, record.header]));
  return persistPreparedBatch({
    parsed, fastaText, manifestText, displayNames, name, out: options.out, config,
  }, context);
}

export function buildBatchSubmission({ fastaText, assignments, assembly, name = 'batch' }) {
  const preview = previewMultiFasta(fastaText);
  if (!preview.valid) throw new Error(preview.errors.map((entry) => entry.message).join(' '));
  const normalizedName = String(name || '').trim();
  if (!normalizedName || normalizedName.length > 80 || /[\u0000-\u001f\u007f]/.test(normalizedName)) {
    throw new Error('批次名称必须为 1–80 个字符且不能包含控制字符。');
  }
  const normalizedAssembly = String(assembly || '').trim();
  if (!ALLOWED_ASSEMBLIES.includes(normalizedAssembly)) {
    throw new Error(`必须为整个批次选择一个有效 assembly：${ALLOWED_ASSEMBLIES.join('、')}。`);
  }
  if (!Array.isArray(assignments) || assignments.length !== preview.records.length) {
    throw new Error('每条 FASTA 记录都必须提供且只能提供一条显示名称设置。');
  }
  const sourceIds = new Set(preview.records.map((record) => record.id));
  const seen = new Set();
  const displayNames = {};
  const manifestRows = assignments.map((assignment, index) => {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      throw new Error(`第 ${index + 1} 条序列设置必须是对象。`);
    }
    const unknown = Object.keys(assignment).filter((key) => !['sequenceId', 'displayName'].includes(key));
    if (unknown.length) throw new Error(`第 ${index + 1} 条序列设置包含未知字段：${unknown.join(', ')}。`);
    const sequenceId = String(assignment.sequenceId || '').trim();
    const displayName = String(assignment.displayName || '').trim();
    if (!sourceIds.has(sequenceId)) throw new Error(`第 ${index + 1} 条设置引用了未知序列：${sequenceId || '(空)'}`);
    if (seen.has(sequenceId)) throw new Error(`序列设置重复：${sequenceId}`);
    if (!displayName || displayName.length > 200 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new Error(`序列 ${sequenceId} 的显示名称为空、过长或包含控制字符。`);
    }
    seen.add(sequenceId);
    displayNames[sequenceId] = displayName;
    return `${sequenceId}\t${sequenceId}\t${normalizedAssembly}`;
  });
  if (seen.size !== sourceIds.size) throw new Error('部分 FASTA 记录缺少显示名称设置。');
  const manifestText = ['sequence_id\tfasta_record\tassembly', ...manifestRows].join('\n');
  const parsed = buildBatch({ fasta: fastaText, manifest: manifestText });
  const assemblies = new Set(parsed.records.map((record) => record.assembly));
  if (assemblies.size !== 1 || !assemblies.has(normalizedAssembly)) {
    throw new Error('网页批次必须且只能包含一个 assembly。');
  }
  return {
    parsed, fastaText, manifestText, displayNames, name: normalizedName, assembly: normalizedAssembly,
  };
}

export function buildWebBatchConfiguration(
  loadedConfig, assembly, primer3Parameters = {}, validationParameters = {},
) {
  const normalized = normalizePrimer3WebParameters(primer3Parameters);
  const validation = normalizeIsPcrWebParameters(validationParameters);
  const config = structuredClone(loadedConfig);
  config.primer3 = { ...(config.primer3 || {}), parameters: normalized.primer3 };
  config.ucsc = {
    ...(config.ucsc || {}),
    minProductSize: validation.minProductSize,
    maxProductSize: validation.maxProductSize,
    parallelism: validation.parallelism,
  };
  return {
    config,
    designSettings: { assembly, primer3: normalized.ui, validation },
  };
}

export function primer3ParametersForBatchConfig(config) {
  const parameters = { ...(config?.primer3?.parameters || {}) };
  // Older batch snapshots predate the web GC controls. Preserve Primer3's historical
  // native 20–80% bounds instead of silently applying the current 40–60% defaults.
  if (!Object.hasOwn(parameters, 'gcMinPercent')) parameters.gcMinPercent = 20;
  if (!Object.hasOwn(parameters, 'gcMaxPercent')) parameters.gcMaxPercent = 80;
  return parameters;
}

export async function batchPrepareData({
  fastaText, assignments, assembly, primer3Parameters = {}, validationParameters = {},
  name = 'batch', out, configPath,
}, context) {
  const submission = buildBatchSubmission({ fastaText, assignments, assembly, name });
  const { config, designSettings } = buildWebBatchConfiguration(
    await context.loadConfig(configPath), submission.assembly, primer3Parameters, validationParameters,
  );
  return persistPreparedBatch({ ...submission, out, config, designSettings }, context);
}

export async function batchDesignPrimer3(options) {
  const { batchDir, batch, checkpoint, config } = await loadBundle(required(options, 'batch'));
  const resultPath = path.join(batchDir, 'primer3-results.json');
  const records = batch.records.map((record) => ({ sequenceId: record.sequenceId, sequence: record.sequence }));
  const recovered = await exists(resultPath);
  const execution = recovered
    ? { parsed: await readJson(resultPath), localRunDir: null, recovered: true }
    : await executeSshPrimer3({
      jobDir: batchDir,
      jobId: batch.batchId,
      records,
      parameters: primer3ParametersForBatchConfig(config),
      serverConfig: config.primer3?.server,
      onProgress: async (progress) => {
        batch.run = { tool: 'Primer3', phase: 'slurm', ...progress, updatedAt: new Date().toISOString() };
        batch.updatedAt = batch.run.updatedAt;
        await writeJson(path.join(batchDir, 'batch.json'), batch);
      },
    });
  const updatedAt = new Date().toISOString();
  if (!Array.isArray(execution.parsed?.records)) throw new Error('Primer3 结果文件缺少 records。');
  if (!recovered) {
    await writeJson(path.join(execution.localRunDir, 'server-run-audit.json'), {
      schemaVersion: 1,
      runId: execution.runId,
      remoteRunDir: execution.remoteRunDir,
      localRunDir: execution.localRunDir,
      slurmJobId: execution.slurmJobId,
      requestSha256: execution.requestSha256,
      completed: execution.completed,
      recordStatuses: execution.parsed.records.map((record) => ({
        sequenceId: record.sequenceId, status: record.status, numReturned: record.numReturned,
      })),
      importedAt: updatedAt,
    });
    await writeJson(resultPath, {
      ...execution.parsed,
      importedAt: updatedAt,
      rawDirectory: execution.localRunDir,
    });
  }
  const candidates = execution.parsed.records.flatMap((record) => {
    const source = batch.records.find((item) => item.sequenceId === record.sequenceId);
    if (!source) throw new Error(`Primer3 返回了未知序列：${record.sequenceId}`);
    const assembly = source.assembly;
    return record.candidates.map((candidate) => ({ ...candidate, assembly }));
  });
  await writeJson(path.join(batchDir, 'candidates.json'), { schemaVersion: 1, updatedAt, candidates });
  let next = checkpoint;
  for (const record of batch.records) {
    const outcome = execution.parsed.records.find((item) => item.sequenceId === record.sequenceId);
    if (!outcome) throw new Error(`Primer3 结果缺少序列：${record.sequenceId}`);
    let state = next.records.find((item) => item.sequenceId === record.sequenceId);
    if (outcome.status === 'ok' && outcome.candidates.length > 0) {
      if (state.stage === 'failed') {
        next = transitionCheckpoint(next, record.sequenceId, 'queued');
        state = next.records.find((item) => item.sequenceId === record.sequenceId);
      }
      if (state.stage === 'queued') next = transitionCheckpoint(next, record.sequenceId, 'designed');
    } else if (state.stage === 'queued') {
      const reason = outcome.errors?.join('; ') || outcome.explain?.pair || 'Primer3 未返回候选引物。';
      next = transitionCheckpoint(next, record.sequenceId, 'failed', { error: reason });
    }
  }
  batch.updatedAt = updatedAt;
  batch.candidateCount = candidates.length;
  batch.status = execution.parsed.records.some((record) => record.status !== 'ok')
    ? 'primer3_complete_with_record_errors' : 'primer3_complete';
  await writeJson(path.join(batchDir, 'checkpoint.json'), next);
  await writeJson(path.join(batchDir, 'batch.json'), batch);
  delete batch.lastError;
  await writeReports(batchDir, batch, candidates, await readResults(batchDir), config);
  console.log(`Primer3 complete: ${candidates.length} candidates from ${batch.records.length} records.`);
  return execution;
}

export async function batchValidateServer(options) {
  const { batchDir, batch, checkpoint, config } = await loadBundle(required(options, 'batch'));
  const candidates = await readCandidates(batchDir);
  if (candidates.some((candidate) => candidate.engine !== 'primer3')) {
    throw new Error('Batch candidates must all be generated by Primer3.');
  }
  if (!candidates.length) {
    batch.updatedAt = new Date().toISOString();
    batch.status = 'complete_with_warnings';
    await writeJson(path.join(batchDir, 'batch.json'), batch);
    await writeReports(batchDir, batch, candidates, await readResults(batchDir), config);
    return {};
  }
  const results = await readResults(batchDir);
  const serverConfig = config.ucsc?.isPcrServer;
  const hasIndependentMinimum = Object.hasOwn(config.ucsc || {}, 'minProductSize');
  const hasIndependentMaximum = Object.hasOwn(config.ucsc || {}, 'maxProductSize');
  const parameters = {
    minSize: hasIndependentMinimum ? config.ucsc.minProductSize : config.primer3.parameters.productSizeMin,
    maxSize: hasIndependentMaximum ? config.ucsc.maxProductSize : config.primer3.parameters.productSizeMax,
    minPerfect: config.ucsc.minPerfect,
    minGood: config.ucsc.minGood,
    flipReverse: config.ucsc.flipReverse,
    parallelism: config.ucsc.parallelism ?? DEFAULT_ISPCR_WEB_PARAMETERS.parallelism,
  };
  const assemblies = [...new Set(candidates.map((candidate) => candidate.assembly))];
  if (assemblies.some((assembly) => !ALLOWED_ASSEMBLIES.includes(assembly))) {
    throw new Error('候选结果包含不支持的 assembly。');
  }
  for (const assembly of assemblies) {
    let subset = candidates.filter((candidate) => candidate.assembly === assembly
      && !resultMatchesIsPcrParameters(results[candidate.candidateId]?.[assembly], parameters));
    let cacheChanged = false;
    for (const candidate of subset) {
      const cached = await readValidationCache(batchDir, candidate, assembly, parameters, serverConfig);
      if (!cached) continue;
      results[candidate.candidateId] = { ...(results[candidate.candidateId] || {}), [assembly]: cached };
      cacheChanged = true;
    }
    if (cacheChanged) {
      await writeJson(path.join(batchDir, 'ucsc-results.json'), {
        schemaVersion: 1, updatedAt: new Date().toISOString(), results,
      });
    }
    subset = subset.filter((candidate) => !resultMatchesIsPcrParameters(
      results[candidate.candidateId]?.[assembly], parameters,
    ));
    if (!subset.length) continue;
    let lastProgressFingerprint = '';
    let lastProgressWrite = 0;
    const saveProgress = async (progress, { force = false } = {}) => {
      const updatedAt = new Date().toISOString();
      const nextRun = {
        tool: 'isPCR/BLAT', assembly,
        jobId: progress.jobId || batch.run?.jobId || null,
        runId: progress.runId || batch.run?.runId || null,
        state: progress.state || batch.run?.state || 'UNKNOWN',
        phase: progress.phase || batch.run?.phase
          || (serverConfig.progressProtocol === 'parallel_v1' ? 'database_check' : 'legacy_slurm'),
        errorCode: progress.errorCode || batch.run?.errorCode || null,
        elapsedMs: Number.isFinite(progress.elapsedMs) ? progress.elapsedMs : batch.run?.elapsedMs,
        candidateTotal: progress.candidateTotal ?? batch.run?.candidateTotal ?? subset.length,
        candidateCompleted: progress.candidateCompleted ?? batch.run?.candidateCompleted ?? 0,
        shardTotal: progress.shardTotal ?? batch.run?.shardTotal ?? null,
        shardCompleted: progress.shardCompleted ?? batch.run?.shardCompleted ?? null,
        activeWorkers: progress.activeWorkers ?? batch.run?.activeWorkers ?? null,
        configuredParallelism: progress.configuredParallelism ?? parameters.parallelism,
        actualParallelism: progress.actualParallelism ?? Math.min(parameters.parallelism, subset.length),
        blatCandidateTotal: progress.blatCandidateTotal ?? batch.run?.blatCandidateTotal ?? 0,
        downloadCompleted: progress.downloadCompleted ?? batch.run?.downloadCompleted ?? null,
        downloadTotal: progress.downloadTotal ?? batch.run?.downloadTotal ?? null,
        reattached: Boolean(progress.reattached || batch.run?.reattached),
        updatedAt,
      };
      const fingerprint = JSON.stringify({ ...nextRun, elapsedMs: null, updatedAt: null });
      const nowMs = Date.now();
      if (!force && fingerprint === lastProgressFingerprint && nowMs - lastProgressWrite < 30_000) return;
      batch.run = nextRun;
      batch.updatedAt = updatedAt;
      await writeJson(path.join(batchDir, 'batch.json'), batch);
      lastProgressFingerprint = fingerprint;
      lastProgressWrite = nowMs;
    };
    batch.run = null;
    await saveProgress({
      phase: 'database_check', state: 'PREPARING', candidateTotal: subset.length,
      candidateCompleted: 0, configuredParallelism: parameters.parallelism,
      actualParallelism: Math.min(parameters.parallelism, subset.length),
    }, { force: true });
    const execution = await executeSshIsPcr({
      jobDir: batchDir,
      jobId: `${batch.batchId.slice(0, 100)}-${assembly}`,
      candidates: subset,
      assemblies: [assembly],
      parameters,
      serverConfig,
      onProgress: saveProgress,
    });
    await writeJson(path.join(execution.localRunDir, 'server-run-audit.json'), {
      schemaVersion: 1,
      runId: execution.runId,
      remoteRunDir: execution.remoteRunDir,
      localRunDir: execution.localRunDir,
      slurmJobId: execution.slurmJobId,
      querySha256: execution.querySha256,
      completed: execution.completed,
      manifest: execution.manifest instanceof Map
        ? Object.fromEntries(execution.manifest) : execution.manifest,
      importedAt: new Date().toISOString(),
    });
    for (const [candidateId, result] of Object.entries(execution.results[assembly])) {
      results[candidateId] = { ...(results[candidateId] || {}), [assembly]: result };
      const candidate = subset.find((item) => item.candidateId === candidateId);
      if (candidate) await writeValidationCache(batchDir, candidate, assembly, parameters, serverConfig, result);
    }
    await writeJson(path.join(batchDir, 'ucsc-results.json'), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      results,
    });
    await saveProgress({ phase: 'reporting', state: 'COMPLETED' }, { force: true });
  }
  const updatedAt = new Date().toISOString();
  await writeJson(path.join(batchDir, 'ucsc-results.json'), { schemaVersion: 1, updatedAt, results });
  let next = checkpoint;
  for (const record of batch.records) {
    const subset = candidates.filter((candidate) => candidate.sequenceId === record.sequenceId);
    const complete = subset.length > 0 && subset.every((candidate) => results[candidate.candidateId]?.[record.assembly]);
    const state = next.records.find((item) => item.sequenceId === record.sequenceId);
    if (complete && state.stage === 'designed') {
      next = transitionCheckpoint(next, record.sequenceId, 'validated');
      next = transitionCheckpoint(next, record.sequenceId, 'complete');
    }
  }
  batch.updatedAt = updatedAt;
  batch.status = next.records.every((record) => record.stage === 'complete') ? 'complete' : 'complete_with_warnings';
  await writeJson(path.join(batchDir, 'checkpoint.json'), next);
  await writeJson(path.join(batchDir, 'batch.json'), batch);
  await writeReports(batchDir, batch, candidates, results, config);
  if (batch.run?.tool === 'isPCR/BLAT') {
    batch.run = { ...batch.run, phase: 'complete', state: 'COMPLETED', updatedAt: new Date().toISOString() };
    batch.updatedAt = batch.run.updatedAt;
    await writeJson(path.join(batchDir, 'batch.json'), batch);
  }
  console.log(`Server validation finished. Report: ${path.join(batchDir, 'report.html')}`);
  return results;
}

export async function batchRevalidate(options) {
  const batchDirectory = required(options, 'batch');
  await upgradeKnownBrokenIsPcrExecution(batchDirectory, options.executionConfig);
  const validation = normalizeIsPcrWebParameters({
    maxProductSize: Number(required(options, 'max-product-size')),
    parallelism: Number(options.parallelism ?? DEFAULT_ISPCR_WEB_PARAMETERS.parallelism),
  });
  const { batchDir, batch, config } = await loadBundle(batchDirectory);
  const previous = {
    minProductSize: Object.hasOwn(config.ucsc || {}, 'minProductSize')
      ? config.ucsc.minProductSize : config.primer3?.parameters?.productSizeMin,
    maxProductSize: Object.hasOwn(config.ucsc || {}, 'maxProductSize')
      ? config.ucsc.maxProductSize : config.primer3?.parameters?.productSizeMax,
    parallelism: config.ucsc?.parallelism ?? DEFAULT_ISPCR_WEB_PARAMETERS.parallelism,
  };
  if (previous.minProductSize !== validation.minProductSize
    || previous.maxProductSize !== validation.maxProductSize
    || previous.parallelism !== validation.parallelism) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const historyDir = path.join(batchDir, 'raw', 'validation-history', stamp);
    await mkdir(path.dirname(historyDir), { recursive: true });
    await mkdir(historyDir, { recursive: false });
    await copyFile(path.join(batchDir, 'config.json'), path.join(historyDir, 'config-before.json'));
    if (await exists(path.join(batchDir, 'ucsc-results.json'))) {
      await copyFile(path.join(batchDir, 'ucsc-results.json'), path.join(historyDir, 'ucsc-results-before.json'));
    }
    await writeJson(path.join(historyDir, 'revalidation-audit.json'), {
      schemaVersion: 1,
      requestedAt: new Date().toISOString(),
      previous,
      next: validation,
    });
  }
  config.ucsc = {
    ...(config.ucsc || {}),
    minProductSize: validation.minProductSize,
    maxProductSize: validation.maxProductSize,
    parallelism: validation.parallelism,
  };
  batch.designSettings = {
    ...(batch.designSettings || {}),
    validation,
  };
  batch.updatedAt = new Date().toISOString();
  batch.status = 'validation_running';
  delete batch.lastError;
  await writeJson(path.join(batchDir, 'config.json'), config);
  await writeJson(path.join(batchDir, 'batch.json'), batch);
  try {
    return await batchValidateServer({ batch: batchDir });
  } catch (error) {
    const failed = await loadBundle(batchDir);
    failed.batch.status = 'retryable_error';
    failed.batch.updatedAt = new Date().toISOString();
    failed.batch.lastError = String(error.message || error).slice(0, 2000);
    await writeJson(path.join(batchDir, 'batch.json'), failed.batch);
    await writeReports(
      batchDir,
      failed.batch,
      await readCandidates(batchDir),
      await readResults(batchDir),
      failed.config,
    );
    throw error;
  }
}

export async function batchReport(options) {
  const { batchDir, batch, config } = await loadBundle(required(options, 'batch'));
  await writeReports(batchDir, batch, await readCandidates(batchDir), await readResults(batchDir), config);
  console.log(`Batch report updated: ${path.join(batchDir, 'report.html')}`);
}

export async function batchRun(options) {
  const batchDir = required(options, 'batch');
  try {
    await upgradeKnownBrokenIsPcrExecution(batchDir, options.executionConfig);
    const beforeDesign = await loadBundle(batchDir);
    beforeDesign.batch.status = 'primer3_running';
    beforeDesign.batch.updatedAt = new Date().toISOString();
    delete beforeDesign.batch.lastError;
    await writeJson(path.join(beforeDesign.batchDir, 'batch.json'), beforeDesign.batch);
    await batchDesignPrimer3(options);

    const beforeValidation = await loadBundle(batchDir);
    beforeValidation.batch.status = 'validation_running';
    beforeValidation.batch.updatedAt = new Date().toISOString();
    await writeJson(path.join(beforeValidation.batchDir, 'batch.json'), beforeValidation.batch);
    await batchValidateServer(options);
  } catch (error) {
    const bundle = await loadBundle(batchDir);
    bundle.batch.status = 'retryable_error';
    bundle.batch.updatedAt = new Date().toISOString();
    bundle.batch.lastError = String(error.message || error).slice(0, 2000);
    await writeJson(path.join(bundle.batchDir, 'batch.json'), bundle.batch);
    await writeReports(
      bundle.batchDir,
      bundle.batch,
      await readCandidates(bundle.batchDir),
      await readResults(bundle.batchDir),
      bundle.config,
    );
    throw error;
  }
}

export async function provisionPrimer3Server(options, context) {
  const config = await context.loadConfig(options.config);
  const server = validatePrimer3ServerConfig(config.primer3?.server);
  const archive = path.join(context.projectRoot, 'vendor', 'primer3', `primer3-${PRIMER3_SOURCE_COMMIT}.tar.gz`);
  const provisionScript = path.join(context.projectRoot, 'scripts', 'server', 'provision-primer3.slurm');
  const runScript = path.join(context.projectRoot, 'scripts', 'server', 'run-primer3.slurm');
  if (await sha256File(archive) !== PRIMER3_SOURCE_SHA256) throw new Error('Local Primer3 source archive SHA-256 mismatch.');
  const connection = [];
  if (server.sshConfigPath) connection.push('-F', server.sshConfigPath);
  connection.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20');
  await runProcess('ssh', [...connection, server.hostAlias, 'mkdir', '-p', `${server.remoteRoot}/downloads`, `${server.remoteRoot}/jobs`, `${server.remoteRoot}/logs`], { timeoutMs: 60_000 });
  await runProcess('scp', [...connection, archive, `${server.hostAlias}:${server.remoteRoot}/downloads/primer3-${PRIMER3_SOURCE_COMMIT}.tar.gz`], { timeoutMs: 600_000 });
  await runProcess('scp', [...connection, provisionScript, `${server.hostAlias}:${server.provisionScript}`], { timeoutMs: 120_000 });
  await runProcess('scp', [...connection, runScript, `${server.hostAlias}:${server.slurmScript}`], { timeoutMs: 120_000 });
  const submitted = await runProcess('ssh', [...connection, server.hostAlias, 'sbatch', '--wait', '--parsable', server.provisionScript], { timeoutMs: server.timeoutMs });
  const jobId = submitted.stdout.match(/(?:^|\n)(\d+)(?:;[^\n]+)?(?:\n|$)/)?.[1];
  if (!jobId) throw new Error('Primer3 provisioning did not return a Slurm job ID.');
  const localManifest = assertADrive(path.join(context.projectRoot, 'vendor', 'primer3', 'primer3-provision-manifest.tsv'), 'Primer3 manifest');
  await runProcess('scp', [...connection, `${server.hostAlias}:${server.remoteRoot}/primer3-provision-manifest.tsv`, localManifest], { timeoutMs: 120_000 });
  console.log(`Primer3 server provisioned with Slurm job ${jobId}. Manifest: ${localManifest}`);
}

export async function handleBatchCommand(command, options, context) {
  if (command === 'batch-prepare') await batchPrepare(options, context);
  else if (command === 'batch-design-primer3') await batchDesignPrimer3(options);
  else if (command === 'batch-validate-server') await batchValidateServer(options);
  else if (command === 'batch-revalidate') await batchRevalidate({
    ...options, executionConfig: context?.loadConfig ? await context.loadConfig(options.config) : undefined,
  });
  else if (command === 'batch-report') await batchReport(options);
  else if (command === 'batch-run') await batchRun({
    ...options, executionConfig: context?.loadConfig ? await context.loadConfig(options.config) : undefined,
  });
  else if (command === 'provision-primer3-server') await provisionPrimer3Server(options, context);
  else return false;
  return true;
}
