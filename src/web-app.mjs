import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPrepareData, batchRevalidate, batchRun } from './batch-cli.mjs';
import { ALLOWED_ASSEMBLIES, previewMultiFasta } from './lib/batch.mjs';
import { buildBatchRows, summarizeBatch } from './lib/batch-report.mjs';
import { readJson, writeJson } from './lib/job.mjs';
import {
  DEFAULT_PRIMER3_WEB_PARAMETERS,
  PRIMER3_WEB_CONSTRAINTS,
} from './lib/primer3.mjs';
import {
  DEFAULT_ISPCR_WEB_PARAMETERS,
  ISPCR_WEB_CONSTRAINTS,
} from './lib/ispcr.mjs';
import { checkLocalSystem, checkRemoteSystem } from './lib/system-check.mjs';
import { moveDirectoryToRecycleBin } from './lib/recycle-bin.mjs';

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const SAFE_BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
export const SERVICE_ID = 'prime-design-local-v1';
export const REPORT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'self'";

export function createAppLifecycle() {
  let activeBatchId = null;
  let mutationBatchId = null;
  let shutdownPending = false;
  let shuttingDown = false;
  return Object.freeze({
    get activeBatchId() { return activeBatchId; },
    get busy() { return activeBatchId !== null || mutationBatchId !== null; },
    get mutationBatchId() { return mutationBatchId; },
    get shutdownPending() { return shutdownPending; },
    get shuttingDown() { return shuttingDown; },
    beginBatch(batchId) {
      if (shuttingDown || shutdownPending) return { status: 'shutting_down' };
      if (mutationBatchId === batchId) return { status: 'mutating', activeBatchId: batchId };
      if (activeBatchId) return { status: 'busy', activeBatchId };
      activeBatchId = batchId;
      return { status: 'started' };
    },
    finishBatch(batchId) {
      if (activeBatchId === batchId) activeBatchId = null;
      if (shutdownPending && !activeBatchId && !mutationBatchId) {
        shuttingDown = true;
        return true;
      }
      return false;
    },
    beginMutation(batchId) {
      if (shuttingDown || shutdownPending) return { status: 'shutting_down' };
      if (activeBatchId === batchId) return { status: 'busy', activeBatchId };
      if (mutationBatchId) return { status: 'mutating', activeBatchId: mutationBatchId };
      mutationBatchId = batchId;
      return { status: 'started' };
    },
    finishMutation(batchId) {
      if (mutationBatchId === batchId) mutationBatchId = null;
      if (shutdownPending && !activeBatchId && !mutationBatchId) {
        shuttingDown = true;
        return true;
      }
      return false;
    },
    requestShutdown(afterCurrent) {
      const currentBatchId = activeBatchId || mutationBatchId;
      if (currentBatchId) {
        if (!afterCurrent) return { status: 'busy', activeBatchId: currentBatchId };
        shutdownPending = true;
        return { status: 'pending', activeBatchId: currentBatchId };
      }
      shuttingDown = true;
      return { status: 'immediate' };
    },
  });
}

function apiError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function securityHeaders(contentType) {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, securityHeaders('application/json; charset=utf-8'));
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw apiError(415, '请求必须使用 application/json。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw apiError(413, '请求内容超过 5 MiB 限制。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw apiError(400, '请求 JSON 无法解析。');
  }
}

function exactObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError(400, `${label} 必须是对象。`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw apiError(400, `${label} 包含未知字段：${unknown.join(', ')}。`);
  return value;
}

function batchPath(batchRoot, batchId) {
  if (!SAFE_BATCH_ID.test(batchId)) throw apiError(400, '批次 ID 无效。');
  const target = path.resolve(batchRoot, batchId);
  const relative = path.relative(batchRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw apiError(400, '批次路径无效。');
  return target;
}

async function optionalJson(filePath, fallback) {
  try { return await readJson(filePath); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function loadBatchView(batchRoot, batchId) {
  const directory = batchPath(batchRoot, batchId);
  const batch = await readJson(path.join(directory, 'batch.json'));
  const checkpoint = await optionalJson(path.join(directory, 'checkpoint.json'), { records: [] });
  const candidateDocument = await optionalJson(path.join(directory, 'candidates.json'), { candidates: [] });
  const resultDocument = await optionalJson(path.join(directory, 'ucsc-results.json'), { results: {} });
  const candidates = candidateDocument.candidates || [];
  const results = resultDocument.results || {};
  return { directory, batch, checkpoint, candidates, results };
}

async function loadBatchStatus(batchRoot, batchId) {
  const directory = batchPath(batchRoot, batchId);
  const batch = await readJson(path.join(directory, 'batch.json'));
  const checkpoint = await optionalJson(path.join(directory, 'checkpoint.json'), { records: [] });
  let candidateCount = Number.isInteger(batch.candidateCount) ? batch.candidateCount : null;
  if (candidateCount === null) {
    const candidateDocument = await optionalJson(path.join(directory, 'candidates.json'), { candidates: [] });
    candidateCount = Array.isArray(candidateDocument.candidates) ? candidateDocument.candidates.length : 0;
    batch.candidateCount = candidateCount;
    await writeJson(path.join(directory, 'batch.json'), batch);
  }
  return { directory, batch, checkpoint, candidateCount };
}

function publicStatus(view, live) {
  const stages = view.checkpoint.records.map((record) => record.stage);
  let status = live?.status || view.batch.status;
  let error = live?.error || view.batch.lastError || null;
  if (!live && /_running$/.test(status)) {
    status = 'retryable_error';
    error = error || '上次运行在完成前中断，可以从断点重试。';
  }
  if (stages.length && stages.every((stage) => stage === 'complete')) status = 'complete';
  else if (stages.length && stages.every((stage) => stage === 'complete' || stage === 'failed')) {
    status = 'complete_with_warnings';
  }
  return {
    batchId: view.batch.batchId,
    name: view.batch.name,
    status,
    error,
    createdAt: view.batch.createdAt,
    updatedAt: view.batch.updatedAt,
    sequenceCount: view.batch.records.length,
    candidateCount: Number.isInteger(view.candidateCount) ? view.candidateCount : (view.candidates?.length || 0),
    run: view.batch.run || null,
    records: view.batch.records.map((record) => {
      const state = view.checkpoint.records.find((item) => item.sequenceId === record.sequenceId);
      return {
        sequenceId: record.sequenceId,
        displayName: record.displayName || record.sequenceId,
        assembly: record.assembly,
        length: record.length,
        stage: state?.stage || 'queued',
        error: state?.error || null,
      };
    }),
  };
}

function publicHistory(view, live) {
  const status = publicStatus(view, live);
  return {
    batchId: status.batchId,
    name: status.name,
    status: status.status,
    error: status.error,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    sequenceCount: status.sequenceCount,
    candidateCount: status.candidateCount,
  };
}

async function listBatches(batchRoot, liveRuns) {
  let entries = [];
  try { entries = await readdir(batchRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const batches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_BATCH_ID.test(entry.name)) continue;
    try {
      const view = await loadBatchStatus(batchRoot, entry.name);
      batches.push(publicHistory(view, liveRuns.get(entry.name)));
    } catch {
      // A non-batch directory or an incomplete manual copy is not advertised.
    }
  }
  return batches.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function ensurePostAuthorized(request, token) {
  if (request.headers['x-prime-design-token'] !== token) throw apiError(403, '本地会话令牌无效，请刷新页面。');
  const origin = request.headers.origin;
  if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin)) {
    throw apiError(403, '请求来源不是本地网页。');
  }
}

export function createPrimerDesignApp({
  projectRoot, appRoot = projectRoot, dataRoot = projectRoot,
  loadConfig, runBatch = batchRun, revalidateBatch = batchRevalidate,
  localSystemCheck = checkLocalSystem, remoteSystemCheck = checkRemoteSystem,
  recycleBatch = moveDirectoryToRecycleBin,
}) {
  const resourceRoot = path.resolve(appRoot);
  const writableRoot = path.resolve(dataRoot);
  if (path.parse(writableRoot).root.toUpperCase() !== 'A:\\') throw new Error('数据目录必须位于 A 盘。');
  const batchRoot = path.join(writableRoot, 'batches');
  const webRoot = path.join(resourceRoot, 'src', 'web');
  const token = randomBytes(24).toString('hex');
  const liveRuns = new Map();
  const lifecycle = createAppLifecycle();
  const startedAt = new Date().toISOString();
  let closeScheduled = false;
  let server;

  function scheduleClose() {
    if (closeScheduled) return;
    closeScheduled = true;
    setImmediate(() => server.close());
  }

  server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(requestUrl.pathname);

      if (request.method === 'GET' && pathname === '/') {
        const html = await readFile(path.join(webRoot, 'index.html'));
        response.writeHead(200, securityHeaders('text/html; charset=utf-8'));
        response.end(html);
        return;
      }
      const staticFiles = new Map([
        ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
        ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
        ['/web-parameters.js', [path.join('..', 'lib', 'web-parameters.mjs'), 'text/javascript; charset=utf-8']],
      ]);
      if (request.method === 'GET' && staticFiles.has(pathname)) {
        const [file, type] = staticFiles.get(pathname);
        response.writeHead(200, securityHeaders(type));
        response.end(await readFile(path.join(webRoot, file)));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/health') {
        const status = lifecycle.shuttingDown ? 'shutting_down'
          : (lifecycle.shutdownPending ? 'shutdown_pending' : 'ok');
        sendJson(response, 200, { serviceId: SERVICE_ID, status, busy: lifecycle.busy, startedAt });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/session') {
        sendJson(response, 200, {
          token,
          assemblies: ALLOWED_ASSEMBLIES,
          primer3: { defaults: DEFAULT_PRIMER3_WEB_PARAMETERS, constraints: PRIMER3_WEB_CONSTRAINTS },
          validation: { defaults: DEFAULT_ISPCR_WEB_PARAMETERS, constraints: ISPCR_WEB_CONSTRAINTS },
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/system') {
        sendJson(response, 200, {
          local: await localSystemCheck({ appRoot: resourceRoot, dataRoot: writableRoot, config: await loadConfig() }),
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/system/remote') {
        ensurePostAuthorized(request, token);
        exactObject(await readJsonBody(request), [], '服务器检查请求');
        sendJson(response, 200, { remote: await remoteSystemCheck({ config: await loadConfig() }) });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/batches') {
        sendJson(response, 200, { batches: await listBatches(batchRoot, liveRuns) });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/batches/preview') {
        ensurePostAuthorized(request, token);
        const body = exactObject(await readJsonBody(request), ['fastaText'], '预检请求');
        const preview = previewMultiFasta(body.fastaText);
        sendJson(response, 200, preview);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/batches') {
        ensurePostAuthorized(request, token);
        const body = exactObject(
          await readJsonBody(request),
          ['fastaText', 'name', 'assembly', 'primer3Parameters', 'validationParameters', 'assignments'],
          '批次请求',
        );
        if (typeof body.fastaText !== 'string' || typeof body.name !== 'string'
          || typeof body.assembly !== 'string' || !Array.isArray(body.assignments)
          || !body.primer3Parameters || typeof body.primer3Parameters !== 'object'
          || Array.isArray(body.primer3Parameters)
          || !body.validationParameters || typeof body.validationParameters !== 'object'
          || Array.isArray(body.validationParameters)) {
          throw apiError(400, '批次请求缺少 FASTA、批次名称、统一 assembly、Primer3 参数或名称设置。');
        }
        let directory;
        try {
          directory = await batchPrepareData({
            fastaText: body.fastaText,
            assignments: body.assignments,
            assembly: body.assembly,
            primer3Parameters: body.primer3Parameters,
            validationParameters: body.validationParameters,
            name: body.name.trim() || 'batch',
          }, { projectRoot: writableRoot, loadConfig });
        } catch (error) {
          if (!error.statusCode) error.statusCode = 400;
          throw error;
        }
        const batchId = path.basename(directory);
        sendJson(response, 201, { batchId, statusUrl: `/api/batches/${batchId}/status` });
        return;
      }

      const archiveMatch = pathname.match(/^\/api\/batches\/([^/]+)\/archive$/);
      if (archiveMatch && request.method === 'POST') {
        ensurePostAuthorized(request, token);
        exactObject(await readJsonBody(request), [], '归档请求');
        const batchId = archiveMatch[1];
        const claim = lifecycle.beginMutation(batchId);
        if (claim.status !== 'started') throw apiError(409, '正在运行或执行文件操作的批次不能归档。');
        try {
          const source = batchPath(batchRoot, batchId);
          await stat(path.join(source, 'batch.json'));
          const archiveRoot = path.join(writableRoot, 'archive');
          await mkdir(archiveRoot, { recursive: true });
          const destination = batchPath(archiveRoot, batchId);
          try {
            await stat(destination);
            throw apiError(409, '归档目录中已存在同名批次。');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          await rename(source, destination);
          sendJson(response, 200, { batchId, status: 'archived' });
        } finally {
          if (lifecycle.finishMutation(batchId)) scheduleClose();
        }
        return;
      }

      const deleteMatch = pathname.match(/^\/api\/batches\/([^/]+)\/delete$/);
      if (deleteMatch && request.method === 'POST') {
        ensurePostAuthorized(request, token);
        const batchId = deleteMatch[1];
        const body = exactObject(await readJsonBody(request), ['confirmation'], '删除请求');
        if (body.confirmation !== batchId) throw apiError(400, '删除确认值必须与批次 ID 完全一致。');
        const source = batchPath(batchRoot, batchId);
        if (path.dirname(source) !== path.resolve(batchRoot)) throw apiError(400, '只能删除 batches 的直接子目录。');
        const claim = lifecycle.beginMutation(batchId);
        if (claim.status !== 'started') throw apiError(409, '该批次正在运行或执行其他文件操作，不能删除。');
        try {
          const [realBatchRoot, realSource] = await Promise.all([realpath(batchRoot), realpath(source)]);
          if (path.dirname(realSource).toLowerCase() !== realBatchRoot.toLowerCase()) {
            throw apiError(400, '批次目录解析后不再是 batches 的直接子目录。');
          }
          const batch = await readJson(path.join(realSource, 'batch.json'));
          if (batch.batchId !== batchId) throw apiError(409, '目录中的 batch.json 与批次 ID 不一致，已拒绝删除。');
          await recycleBatch({ targetPath: realSource, appRoot: resourceRoot });
          liveRuns.delete(batchId);
          sendJson(response, 200, { batchId, status: 'recycled', recoverable: true });
        } finally {
          if (lifecycle.finishMutation(batchId)) scheduleClose();
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/app/shutdown') {
        ensurePostAuthorized(request, token);
        const body = exactObject(await readJsonBody(request), ['afterCurrent'], '退出请求');
        if (typeof body.afterCurrent !== 'boolean') throw apiError(400, 'afterCurrent 必须是布尔值。');
        const outcome = lifecycle.requestShutdown(body.afterCurrent);
        if (outcome.status === 'busy') {
          throw apiError(409, `批次 ${outcome.activeBatchId} 正在运行；可选择任务完成后自动退出。`);
        }
        sendJson(response, 202, {
          status: outcome.status === 'pending' ? 'shutdown_pending' : 'shutting_down',
          activeBatchId: outcome.activeBatchId || null,
        });
        if (outcome.status === 'immediate') scheduleClose();
        return;
      }

      const match = pathname.match(/^\/api\/batches\/([^/]+)\/(run|revalidate|status|results)$/);
      if (match) {
        const [, batchId, action] = match;
        const directory = batchPath(batchRoot, batchId);
        await stat(path.join(directory, 'batch.json'));
        if (request.method === 'POST' && action === 'run') {
          ensurePostAuthorized(request, token);
          const start = lifecycle.beginBatch(batchId);
          if (start.status === 'busy') throw apiError(409, `已有批次 ${start.activeBatchId} 正在运行，请等待完成。`);
          if (start.status === 'mutating') throw apiError(409, '该批次正在执行文件操作，请稍后再试。');
          if (start.status === 'shutting_down') throw apiError(409, '软件正在退出，不再接受新任务。');
          liveRuns.set(batchId, { status: 'starting', error: null });
          setImmediate(async () => {
            try {
              liveRuns.set(batchId, { status: 'running', error: null });
              await runBatch({ batch: directory });
              const view = await loadBatchStatus(batchRoot, batchId);
              liveRuns.set(batchId, { status: view.batch.status, error: view.batch.lastError || null });
            } catch (error) {
              liveRuns.set(batchId, { status: 'retryable_error', error: String(error.message || error) });
            } finally {
              if (lifecycle.finishBatch(batchId)) scheduleClose();
            }
          });
          sendJson(response, 202, { batchId, status: 'starting' });
          return;
        }
        if (request.method === 'POST' && action === 'revalidate') {
          ensurePostAuthorized(request, token);
          const body = exactObject(await readJsonBody(request), ['maxProductSize'], '重新验证请求');
          if (typeof body.maxProductSize !== 'number') throw apiError(400, 'maxProductSize 必须是数字。');
          const start = lifecycle.beginBatch(batchId);
          if (start.status === 'busy') throw apiError(409, `已有批次 ${start.activeBatchId} 正在运行，请等待完成。`);
          if (start.status === 'mutating') throw apiError(409, '该批次正在执行文件操作，请稍后再试。');
          if (start.status === 'shutting_down') throw apiError(409, '软件正在退出，不再接受新任务。');
          liveRuns.set(batchId, { status: 'starting', error: null });
          setImmediate(async () => {
            try {
              liveRuns.set(batchId, { status: 'running', error: null });
              await revalidateBatch({ batch: directory, 'max-product-size': body.maxProductSize });
              const view = await loadBatchStatus(batchRoot, batchId);
              liveRuns.set(batchId, { status: view.batch.status, error: view.batch.lastError || null });
            } catch (error) {
              liveRuns.set(batchId, { status: 'retryable_error', error: String(error.message || error) });
            } finally {
              if (lifecycle.finishBatch(batchId)) scheduleClose();
            }
          });
          sendJson(response, 202, { batchId, status: 'starting' });
          return;
        }
        if (request.method === 'GET' && action === 'status') {
          const view = await loadBatchStatus(batchRoot, batchId);
          sendJson(response, 200, publicStatus(view, liveRuns.get(batchId)));
          return;
        }
        if (request.method === 'GET' && action === 'results') {
          const view = await loadBatchView(batchRoot, batchId);
          sendJson(response, 200, {
            batchId,
            status: publicStatus(view, liveRuns.get(batchId)),
            summary: summarizeBatch(view),
            rows: buildBatchRows(view),
            reportUrl: `/batches/${batchId}/report.html`,
            csvUrl: `/batches/${batchId}/summary.csv`,
          });
          return;
        }
        throw apiError(405, '不支持的请求方法。');
      }

      const artifact = pathname.match(/^\/batches\/([^/]+)\/(report\.html|summary\.csv)$/);
      if (request.method === 'GET' && artifact) {
        const [, batchId, file] = artifact;
        const directory = batchPath(batchRoot, batchId);
        const type = file.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8';
        const headers = securityHeaders(type);
        if (file.endsWith('.html')) headers['content-security-policy'] = REPORT_CSP;
        if (file.endsWith('.csv')) headers['content-disposition'] = `attachment; filename="${batchId}-summary.csv"`;
        response.writeHead(200, headers);
        response.end(await readFile(path.join(directory, file)));
        return;
      }

      throw apiError(404, '未找到该页面或接口。');
    } catch (error) {
      const statusCode = error.code === 'ENOENT' ? 404 : (error.statusCode || 500);
      sendJson(response, statusCode, { error: statusCode === 500 ? `操作失败：${error.message}` : error.message });
    }
  });

  return { server, token, batchRoot, lifecycle };
}

export async function listenPrimerDesignApp({
  projectRoot, appRoot = projectRoot, dataRoot = projectRoot,
  loadConfig, runBatch, revalidateBatch, localSystemCheck, remoteSystemCheck, recycleBatch, port = 43110,
} = {}) {
  const app = createPrimerDesignApp({
    projectRoot, appRoot, dataRoot, loadConfig, runBatch, revalidateBatch,
    localSystemCheck, remoteSystemCheck, recycleBatch,
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  return { ...app, url: `http://127.0.0.1:${address.port}` };
}
