import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import {
  REPORT_CSP,
  SERVICE_ID,
  createAppLifecycle,
  listenPrimerDesignApp,
} from '../src/web-app.mjs';
import { moveDirectoryToRecycleBin } from '../src/lib/recycle-bin.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withApp(run) {
  const app = await listenPrimerDesignApp({ projectRoot, port: 0, loadConfig: async () => ({ schemaVersion: 1 }) });
  try {
    await run(app);
  } finally {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
  }
}

test('web app binds to loopback and serves the local UI', async () => withApp(async (app) => {
  assert.equal(app.server.address().address, '127.0.0.1');
  const response = await fetch(app.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /charset=utf-8/);
  const html = await response.text();
  assert.match(html, /批量引物设计/);
  assert.match(html, /data-theme="glass-laboratory"/);
  assert.match(html, /id="batchAssembly"/);
  assert.match(html, /id="primer3Parameters"/);
  assert.match(html, /id="validationMaxProductSize"/);
  assert.match(html, /id="validationParallelism"/);
  assert.match(html, /id="previewReportButton"/);
  assert.match(html, /<dialog id="reportDialog"/);
  assert.match(html, /id="reportDialogClose"/);
  assert.match(html, /id="exitButton"/);
  for (const id of [
    'numReturn', 'tmTargetC', 'tmToleranceC', 'primerLengthMin', 'primerLengthOpt',
    'primerLengthMax', 'productSizeMin', 'productSizeMax', 'validationMaxProductSize', 'validationParallelism',
    'gcMinPercent', 'gcMaxPercent',
  ]) {
    assert.match(html, new RegExp(`id="${id}" type="text" inputmode="(?:numeric|decimal)"`));
  }
  assert.doesNotMatch(html, /themes\.css|themeButton|themeDialog/);
}));

test('session, health, and fixed glass CSS expose only safe local metadata', async () => withApp(async (app) => {
  const health = await (await fetch(`${app.url}/api/health`)).json();
  assert.deepEqual({ serviceId: health.serviceId, status: health.status, busy: health.busy }, {
    serviceId: SERVICE_ID, status: 'ok', busy: false,
  });
  assert.equal(health.token, undefined);
  assert.equal(health.remoteRoot, undefined);
  const session = await (await fetch(`${app.url}/api/session`)).json();
  assert.deepEqual(session.assemblies, ['hs1', 'hg38', 'mm10']);
  assert.equal(session.primer3.defaults.numReturn, 5);
  assert.equal(session.primer3.defaults.gcMinPercent, 40);
  assert.equal(session.primer3.constraints.numReturn.max, 20);
  assert.equal(session.validation.defaults.maxProductSize, 10000);
  assert.equal(session.validation.defaults.parallelism, 4);
  assert.deepEqual(session.validation.constraints.maxProductSize, { min: 1000, max: 50000, integer: true });
  assert.equal(session.validation.constraints.minProductSize, 0);
  assert.deepEqual(session.validation.constraints.parallelism, { min: 4, max: 8, integer: true });
  assert.equal(JSON.stringify(session).includes('remoteRoot'), false);
  assert.equal((await fetch(`${app.url}/api/themes`)).status, 404);
  assert.equal((await fetch(`${app.url}/themes.css`)).status, 404);
  const baseCss = await (await fetch(`${app.url}/styles.css`)).text();
  assert.match(baseCss, /--panel-blur:0px/);
  assert.match(baseCss, /\.parameter-grid input\{border:1\.5px solid/);
  assert.match(baseCss, /\.parameter-grid input:hover\{border-color:/);
  assert.match(baseCss, /\.parameter-grid input:focus-visible\{border-color:var\(--primary\)/);
  assert.match(baseCss, /\.parameter-grid input\[aria-invalid="true"\]\{border-color:var\(--danger\)/);
  assert.match(baseCss, /--panel-border:#a9bdcf/);
  assert.match(baseCss, /--control-border:#7890a6/);
  assert.match(baseCss, /input,textarea,select,button,\.button\{border-width:1\.5px/);
  assert.match(baseCss, /#fastaFile::file-selector-button/);
  assert.match(baseCss, /\.record,\.history-row\{border:1px solid var\(--panel-border\)/);
  assert.match(baseCss, /\.history-actions\{display:flex/);
  assert.doesNotMatch(baseCss, /backdrop-filter|background-attachment\s*:\s*fixed/);
  assert.match(baseCss, /prefers-reduced-motion/);
  assert.match(REPORT_CSP, /frame-ancestors 'self'/);
}));

test('client loads reports on demand, slows hidden polling, and exposes recycle deletion instead of archive', async () => {
  const source = await readFile(path.join(projectRoot, 'src', 'web', 'app.js'), 'utf8');
  const showResults = source.match(/async function showResults[\s\S]*?\n}/)?.[0] || '';
  assert.doesNotMatch(showResults, /\/results|reportFrame\.src/);
  assert.match(source, /previewReportButton/);
  assert.match(source, /showModal\(\)/);
  assert.match(source, /reportDialogClose/);
  assert.match(source, /document\.body\.classList\.add\('report-open'\)/);
  assert.match(source, /phase === 'database_check'/);
  assert.match(source, /candidateCompleted/);
  assert.match(source, /正在下载结果/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /document\.hidden \? 10000 : 2000/);
  assert.match(source, /\/delete/);
  assert.match(source, /移入 Windows 回收站/);
  assert.match(source, /updateParameterValidity/);
  assert.match(source, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(source, /actions\.className = 'history-actions'/);
  assert.doesNotMatch(source, /textContent = '归档'|\/archive/);
});

test('system checks keep remote probing explicit, authorized, and redacted', async () => {
  let remoteCalls = 0;
  const app = await listenPrimerDesignApp({
    projectRoot,
    port: 0,
    loadConfig: async () => ({ schemaVersion: 1 }),
    localSystemCheck: async () => ({ version: '0.3.0', dataOnADrive: true, dataWritable: true, ready: true }),
    remoteSystemCheck: async () => { remoteCalls += 1; return { connected: true, ready: true }; },
  });
  try {
    const local = await (await fetch(`${app.url}/api/system`)).json();
    assert.equal(local.local.ready, true);
    assert.equal(remoteCalls, 0);
    const denied = await fetch(`${app.url}/api/system/remote`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 403);
    const session = await (await fetch(`${app.url}/api/session`)).json();
    const checked = await fetch(`${app.url}/api/system/remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prime-design-token': session.token },
      body: '{}',
    });
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), { remote: { connected: true, ready: true } });
    assert.equal(remoteCalls, 1);
  } finally {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
  }
});

test('preview API requires a session token and returns validated CRLF records', async () => withApp(async (app) => {
  const denied = await fetch(`${app.url}/api/batches/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fastaText: '>x\nAAAA' }),
  });
  assert.equal(denied.status, 403);
  const session = await (await fetch(`${app.url}/api/session`)).json();
  const fastaText = `>target_001 full name\r\n${'ACGT'.repeat(25)}`;
  const response = await fetch(`${app.url}/api/batches/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-prime-design-token': session.token },
    body: JSON.stringify({ fastaText }),
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.records.map(({ id, length }) => ({ id, length })), [{ id: 'target_001', length: 100 }]);
}));

test('web API rejects unknown request fields and path traversal', async () => withApp(async (app) => {
  const session = await (await fetch(`${app.url}/api/session`)).json();
  const unknown = await fetch(`${app.url}/api/batches/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-prime-design-token': session.token },
    body: JSON.stringify({ fastaText: '>x\nAAAA', path: 'C:\\secret' }),
  });
  assert.equal(unknown.status, 400);
  const traversal = await fetch(`${app.url}/api/batches/%2e%2e/status`);
  assert.ok([400, 404].includes(traversal.status));
  const legacyAssignment = await fetch(`${app.url}/api/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-prime-design-token': session.token },
    body: JSON.stringify({
      fastaText: `>x\n${'ACGT'.repeat(25)}`,
      name: 'x',
      assembly: 'hs1',
      primer3Parameters: {
        numReturn: 5, tmTargetC: 60, tmToleranceC: 5,
        primerLengthMin: 18, primerLengthOpt: 23, primerLengthMax: 28,
        productSizeMin: 80, productSizeMax: 1000, gcMinPercent: 40, gcMaxPercent: 60,
      },
      validationParameters: { maxProductSize: 10000 },
      assignments: [{ sequenceId: 'x', displayName: 'x', assembly: 'hs1' }],
    }),
  });
  assert.equal(legacyAssignment.status, 400);
}));

test('application lifecycle refuses an immediate busy shutdown and closes after the active run', () => {
  const lifecycle = createAppLifecycle();
  assert.equal(lifecycle.beginBatch('batch-1').status, 'started');
  assert.deepEqual(lifecycle.requestShutdown(false), { status: 'busy', activeBatchId: 'batch-1' });
  assert.deepEqual(lifecycle.requestShutdown(true), { status: 'pending', activeBatchId: 'batch-1' });
  assert.equal(lifecycle.beginBatch('batch-2').status, 'shutting_down');
  assert.equal(lifecycle.finishBatch('batch-1'), true);
  assert.equal(lifecycle.shuttingDown, true);
});

test('application lifecycle serializes run and destructive batch mutations', () => {
  const lifecycle = createAppLifecycle();
  assert.equal(lifecycle.beginMutation('batch-1').status, 'started');
  assert.equal(lifecycle.beginBatch('batch-1').status, 'mutating');
  assert.equal(lifecycle.beginMutation('batch-2').status, 'mutating');
  lifecycle.finishMutation('batch-1');
  assert.equal(lifecycle.beginBatch('batch-1').status, 'started');
  assert.equal(lifecycle.beginMutation('batch-1').status, 'busy');
  lifecycle.finishBatch('batch-1');

  const concurrent = createAppLifecycle();
  assert.equal(concurrent.beginBatch('batch-a').status, 'started');
  assert.equal(concurrent.beginMutation('batch-b').status, 'started');
  assert.equal(concurrent.requestShutdown(true).status, 'pending');
  assert.equal(concurrent.finishMutation('batch-b'), false);
  assert.equal(concurrent.finishBatch('batch-a'), true);
});

async function isolatedDataRoot() {
  const root = path.join(projectRoot, '.test-runtime', randomUUID());
  await mkdir(path.join(root, 'batches'), { recursive: true });
  return root;
}

async function writeBatchFixture(dataRoot, batchId, { status = 'complete', candidateCount = 1, run = null } = {}) {
  const directory = path.join(dataRoot, 'batches', batchId);
  await mkdir(directory, { recursive: true });
  const batch = {
    batchId, name: batchId, status, candidateCount,
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
    records: [{ sequenceId: 'seq_1', displayName: 'seq 1', assembly: 'hs1', length: 100 }],
    ...(run ? { run } : {}),
  };
  await writeFile(path.join(directory, 'batch.json'), `${JSON.stringify(batch)}\n`, 'utf8');
  await writeFile(path.join(directory, 'checkpoint.json'), `${JSON.stringify({ records: [{ sequenceId: 'seq_1', stage: 'complete' }] })}\n`, 'utf8');
  return directory;
}

async function recycleTestRoot(root) {
  try { await stat(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await moveDirectoryToRecycleBin({ targetPath: root, appRoot: projectRoot });
}

test('history and status stay lightweight when full result files are malformed', async () => {
  const dataRoot = await isolatedDataRoot();
  const directory = await writeBatchFixture(dataRoot, 'lightweight-fixture');
  await writeFile(path.join(directory, 'candidates.json'), '{malformed candidates', 'utf8');
  await writeFile(path.join(directory, 'ucsc-results.json'), '{malformed results', 'utf8');
  const app = await listenPrimerDesignApp({
    projectRoot, appRoot: projectRoot, dataRoot, port: 0,
    loadConfig: async () => ({ schemaVersion: 1 }),
  });
  try {
    const history = await (await fetch(`${app.url}/api/batches`)).json();
    assert.equal(history.batches.length, 1);
    assert.equal(history.batches[0].candidateCount, 1);
    assert.equal(history.batches[0].records, undefined);
    const status = await fetch(`${app.url}/api/batches/lightweight-fixture/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).records.length, 1);
    assert.equal((await fetch(`${app.url}/api/batches/lightweight-fixture/results`)).status, 500);
  } finally {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
    await recycleTestRoot(dataRoot);
  }
});

test('status API exposes progress fields but redacts server and local paths', async () => {
  const dataRoot = await isolatedDataRoot();
  await writeBatchFixture(dataRoot, 'progress-fixture', { status: 'validation_running', run: {
    tool: 'isPCR/BLAT', assembly: 'mm10', jobId: '2349343', runId: 'run-safe',
    state: 'RUNNING', phase: 'ispcr', candidateTotal: 30, candidateCompleted: 8,
    activeWorkers: 3, configuredParallelism: 4, actualParallelism: 4,
    remoteRunDir: '/secret/remote/run', localRunDir: 'A:\\secret\\run',
  } });
  const app = await listenPrimerDesignApp({
    projectRoot, appRoot: projectRoot, dataRoot, port: 0,
    loadConfig: async () => ({ schemaVersion: 1 }),
  });
  try {
    const body = await (await fetch(`${app.url}/api/batches/progress-fixture/status`)).json();
    assert.equal(body.run.phase, 'ispcr');
    assert.equal(body.run.candidateCompleted, 8);
    assert.equal(body.run.activeWorkers, 3);
    assert.equal(body.run.remoteRunDir, undefined);
    assert.equal(body.run.localRunDir, undefined);
    assert.doesNotMatch(JSON.stringify(body), /secret/);
  } finally {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
    await recycleTestRoot(dataRoot);
  }
});

test('results API returns validated 1-based input-template primer intervals', async () => {
  const dataRoot = await isolatedDataRoot();
  const directory = await writeBatchFixture(dataRoot, 'position-fixture');
  await writeFile(path.join(directory, 'candidates.json'), `${JSON.stringify({
    schemaVersion: 1,
    candidates: [{
      sequenceId: 'seq_1', assembly: 'hs1', engine: 'primer3', candidateId: 'seq_1.p3.01', pairRank: 1,
      forwardSequence: 'ACGT', reverseSequence: 'TGCA', forwardPosition: 10, forwardLength: 4,
      reversePosition: 96, reverseLength: 4, productLength: 90, pairPenalty: 0.1,
    }],
  })}\n`, 'utf8');
  await writeFile(path.join(directory, 'ucsc-results.json'), `${JSON.stringify({
    schemaVersion: 1,
    results: {
      'seq_1.p3.01': {
        hs1: {
          classification: 'pass_single_product',
          products: [{ contig: 'chr1', start1: 11, end1: 100, productSize: 90, contigClass: 'primary' }],
          blatSummary: { forwardHits: 3, reverseHits: 2, forwardFullLengthExact: 1, reverseFullLengthExact: 1 },
          blatReviewStatus: 'reviewed_suspicious_only',
        },
      },
    },
  })}\n`, 'utf8');
  const app = await listenPrimerDesignApp({
    projectRoot, appRoot: projectRoot, dataRoot, port: 0,
    loadConfig: async () => ({ schemaVersion: 1 }),
  });
  try {
    const response = await fetch(`${app.url}/api/batches/position-fixture/results`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rows[0].forward_input_start_1based, 11);
    assert.equal(body.rows[0].forward_input_end_1based, 14);
    assert.equal(body.rows[0].reverse_input_start_1based, 97);
    assert.equal(body.rows[0].reverse_input_end_1based, 100);
    assert.equal(body.rows[0].classificationLabel, '唯一产物');
    assert.equal(body.rows[0].genomicProductLocations, 'chr1:11-100');
    assert.equal(Object.hasOwn(body.rows[0], 'blatForwardHits'), false);
    assert.equal(Object.hasOwn(body.rows[0], 'blatReviewStatus'), false);
    assert.doesNotMatch(JSON.stringify(body.rows[0]), /blat/i);
  } finally {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
    await recycleTestRoot(dataRoot);
  }
});

test('delete API is authorized, fail-closed, recoverable, and removes only the selected batch', async () => {
  const dataRoot = await isolatedDataRoot();
  const good = await writeBatchFixture(dataRoot, 'delete-fixture');
  const failed = await writeBatchFixture(dataRoot, 'failure-fixture');
  const recycled = path.join(dataRoot, 'recycled-fixture');
  const app = await listenPrimerDesignApp({
    projectRoot, appRoot: projectRoot, dataRoot, port: 0,
    loadConfig: async () => ({ schemaVersion: 1 }),
    recycleBatch: async ({ targetPath }) => {
      if (path.basename(targetPath) === 'failure-fixture') throw new Error('simulated recycle failure');
      await rename(targetPath, recycled);
    },
  });
  try {
    const denied = await fetch(`${app.url}/api/batches/delete-fixture/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'delete-fixture' }),
    });
    assert.equal(denied.status, 403);
    const session = await (await fetch(`${app.url}/api/session`)).json();
    const headers = { 'content-type': 'application/json', 'x-prime-design-token': session.token };
    const wrong = await fetch(`${app.url}/api/batches/delete-fixture/delete`, {
      method: 'POST', headers, body: JSON.stringify({ confirmation: 'wrong' }),
    });
    assert.equal(wrong.status, 400);
    assert.equal(app.lifecycle.beginBatch('failure-fixture').status, 'started');
    const busy = await fetch(`${app.url}/api/batches/failure-fixture/delete`, {
      method: 'POST', headers, body: JSON.stringify({ confirmation: 'failure-fixture' }),
    });
    assert.equal(busy.status, 409);
    app.lifecycle.finishBatch('failure-fixture');
    const failure = await fetch(`${app.url}/api/batches/failure-fixture/delete`, {
      method: 'POST', headers, body: JSON.stringify({ confirmation: 'failure-fixture' }),
    });
    assert.equal(failure.status, 500);
    assert.equal((await stat(failed)).isDirectory(), true);
    const success = await fetch(`${app.url}/api/batches/delete-fixture/delete`, {
      method: 'POST', headers, body: JSON.stringify({ confirmation: 'delete-fixture' }),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { batchId: 'delete-fixture', status: 'recycled', recoverable: true });
    await assert.rejects(stat(good), { code: 'ENOENT' });
    assert.equal((await stat(recycled)).isDirectory(), true);
    assert.equal((await fetch(`${app.url}/api/batches/delete-fixture/status`)).status, 404);
  } finally {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
    await recycleTestRoot(dataRoot);
  }
});

test('shutdown endpoint requires authorization and closes an idle server after responding', async () => {
  const app = await listenPrimerDesignApp({ projectRoot, port: 0, loadConfig: async () => ({ schemaVersion: 1 }) });
  try {
    const denied = await fetch(`${app.url}/api/app/shutdown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ afterCurrent: false }),
    });
    assert.equal(denied.status, 403);
    const session = await (await fetch(`${app.url}/api/session`)).json();
    const closed = new Promise((resolve) => app.server.once('close', resolve));
    const response = await fetch(`${app.url}/api/app/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prime-design-token': session.token },
      body: JSON.stringify({ afterCurrent: false }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'shutting_down', activeBatchId: null });
    await closed;
    assert.equal(app.server.listening, false);
  } finally {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
  }
});
