import { parseNumericInput } from '/web-parameters.js';

const state = {
  token: null,
  assemblies: [],
  primer3Defaults: null,
  primer3Constraints: null,
  validationDefaults: null,
  validationConstraints: null,
  preview: null,
  batchId: null,
  timer: null,
  pollingActive: false,
  pollGeneration: 0,
  pollController: null,
};
const $ = (selector) => document.querySelector(selector);
const PARAMETER_IDS = [
  'numReturn', 'tmTargetC', 'tmToleranceC', 'primerLengthMin', 'primerLengthOpt',
  'primerLengthMax', 'productSizeMin', 'productSizeMax', 'gcMinPercent', 'gcMaxPercent',
];
const INTEGER_PARAMETER_IDS = new Set([
  'numReturn', 'primerLengthMin', 'primerLengthOpt', 'primerLengthMax',
  'productSizeMin', 'productSizeMax', 'validationMaxProductSize',
]);

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  if (options.method === 'POST') headers['x-prime-design-token'] = state.token;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function text(node, value) { node.textContent = value ?? ''; }
function show(node, visible = true) { node.classList.toggle('hidden', !visible); }
function renderErrors(errors) {
  const list = $('#errors');
  list.replaceChildren();
  for (const error of errors) {
    const item = document.createElement('li');
    item.textContent = error.message;
    list.append(item);
  }
}
function clearErrors() { renderErrors([]); }
function showError(error) { renderErrors([{ message: error.message || String(error) }]); }

function numericValue(id) {
  return parseNumericInput($(`#${id}`).value, { integer: INTEGER_PARAMETER_IDS.has(id) });
}

function readPrimer3Parameters() {
  return Object.fromEntries(PARAMETER_IDS.map((id) => [id, numericValue(id)]));
}

function readValidationParameters() {
  return { maxProductSize: numericValue('validationMaxProductSize') };
}

function validationParameterValidation(parameters) {
  const invalidIds = new Set();
  const value = parameters.maxProductSize;
  const limits = state.validationConstraints?.maxProductSize || { min: 1000, max: 50000 };
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < limits.min || value > limits.max) {
    invalidIds.add('validationMaxProductSize');
    return { errors: [`基因组 isPCR 最大产物长度必须是 ${limits.min}–${limits.max} 的整数。`], invalidIds };
  }
  return { errors: [], invalidIds };
}

function validateValidationParameters(parameters) {
  return validationParameterValidation(parameters).errors;
}

function primer3ParameterValidation(parameters) {
  const errors = [];
  const invalidIds = new Set();
  const candidateLimits = state.primer3Constraints?.numReturn || { min: 1, max: 20 };
  const lengthLimits = state.primer3Constraints?.primerLength || { min: 1, max: 35 };
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${key} 必须是有效数字。`);
      invalidIds.add(key);
    }
  }
  if (errors.length) return { errors, invalidIds };
  if (!Number.isSafeInteger(parameters.numReturn)
    || parameters.numReturn < candidateLimits.min || parameters.numReturn > candidateLimits.max) {
    errors.push(`候选引物对总数必须是 ${candidateLimits.min}–${candidateLimits.max} 的整数。`);
    invalidIds.add('numReturn');
  }
  const lengths = [parameters.primerLengthMin, parameters.primerLengthOpt, parameters.primerLengthMax];
  if (lengths.some((value) => !Number.isSafeInteger(value)
    || value < lengthLimits.min || value > lengthLimits.max)) {
    errors.push(`引物长度必须是 ${lengthLimits.min}–${lengthLimits.max} 的整数。`);
    invalidIds.add('primerLengthMin');
    invalidIds.add('primerLengthOpt');
    invalidIds.add('primerLengthMax');
  } else if (!(lengths[0] <= lengths[1] && lengths[1] <= lengths[2])) {
    errors.push('引物长度必须满足：最小 ≤ 最适 ≤ 最大。');
    invalidIds.add('primerLengthMin');
    invalidIds.add('primerLengthOpt');
    invalidIds.add('primerLengthMax');
  }
  if (parameters.tmToleranceC < 0) {
    errors.push('Tm 容差不能为负数。');
    invalidIds.add('tmToleranceC');
  }
  if (!Number.isFinite(parameters.tmTargetC - parameters.tmToleranceC)
    || !Number.isFinite(parameters.tmTargetC + parameters.tmToleranceC)) {
    errors.push('Tm 派生范围超出有效数字范围。');
    invalidIds.add('tmTargetC');
    invalidIds.add('tmToleranceC');
  }
  const products = [parameters.productSizeMin, parameters.productSizeMax];
  if (products.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    errors.push('产物长度必须是正整数。');
    invalidIds.add('productSizeMin');
    invalidIds.add('productSizeMax');
  } else if (products[0] > products[1]) {
    errors.push('产物最小长度不能大于最大长度。');
    invalidIds.add('productSizeMin');
    invalidIds.add('productSizeMax');
  }
  if (parameters.gcMinPercent < 0 || parameters.gcMaxPercent > 100
    || parameters.gcMinPercent > parameters.gcMaxPercent) {
    errors.push('GC 范围必须满足 0 ≤ 最小值 ≤ 最大值 ≤ 100。');
    invalidIds.add('gcMinPercent');
    invalidIds.add('gcMaxPercent');
  }
  return { errors, invalidIds };
}

function validatePrimer3Parameters(parameters) {
  return primer3ParameterValidation(parameters).errors;
}

function updateParameterValidity(primer3Parameters, validationParameters) {
  const invalidIds = new Set([
    ...primer3ParameterValidation(primer3Parameters).invalidIds,
    ...validationParameterValidation(validationParameters).invalidIds,
  ]);
  for (const id of [...PARAMETER_IDS, 'validationMaxProductSize']) {
    const input = $(`#${id}`);
    if (invalidIds.has(id)) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function updateParameterSummary() {
  const target = numericValue('tmTargetC');
  const tolerance = numericValue('tmToleranceC');
  text($('#tmRange'), Number.isFinite(target) && Number.isFinite(tolerance) && tolerance >= 0
    ? `允许范围：${target - tolerance}–${target + tolerance}°C`
    : '允许范围：请填写有效的目标值和容差');
  const count = numericValue('numReturn');
  const limits = state.primer3Constraints?.numReturn || { min: 1, max: 20 };
  text($('#candidateSummary'), Number.isSafeInteger(count) && count >= limits.min && count <= limits.max
    ? `每条 FASTA 最多返回 ${count} 对候选引物（含排名第 1 的首选对）。`
    : `每条 FASTA 可返回 ${limits.min}–${limits.max} 对候选引物。`);
}

function applyPrimer3Defaults() {
  if (!state.primer3Defaults) return;
  for (const id of PARAMETER_IDS) $(`#${id}`).value = state.primer3Defaults[id];
  if (state.validationDefaults) {
    $('#validationMaxProductSize').value = state.validationDefaults.maxProductSize;
  }
  updateParameterSummary();
  updateRunButton();
}

function invalidatePreview() {
  state.preview = null;
  $('#previewBody').replaceChildren();
  show($('#previewPanel'), false);
  text($('#previewSummary'), 'FASTA 已改变，请重新解析。');
  updateRunButton();
}

function collectSubmissionErrors() {
  const errors = [];
  if (!state.preview?.valid) errors.push('请先解析并通过 FASTA 检查。');
  if (!$('#batchAssembly').value) errors.push('必须为本批次手动选择一个基因组。');
  errors.push(...validatePrimer3Parameters(readPrimer3Parameters()));
  errors.push(...validateValidationParameters(readValidationParameters()));
  for (const input of $('#previewBody').querySelectorAll('[data-role="display-name"]')) {
    if (!input.value.trim()) errors.push(`序列 ${input.dataset.sequenceId} 的显示名称不能为空。`);
  }
  return errors;
}

function updateRunButton() {
  updateParameterSummary();
  const names = [...$('#previewBody').querySelectorAll('[data-role="display-name"]')];
  const primer3Parameters = readPrimer3Parameters();
  const validationParameters = readValidationParameters();
  updateParameterValidity(primer3Parameters, validationParameters);
  $('#runButton').disabled = !state.preview?.valid || !$('#batchAssembly').value || !names.length
    || names.some((item) => !item.value.trim())
    || validatePrimer3Parameters(primer3Parameters).length > 0
    || validateValidationParameters(validationParameters).length > 0;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function renderSystemCheck(local, remote = null) {
  const remoteToolsReady = remote ? Object.values(remote.tools || {}).every(Boolean) : false;
  const remoteGenomesReady = remote ? Object.values(remote.assemblies || {}).every(Boolean) : false;
  const toolVersions = remote?.toolVersions || {};
  const values = [
    ['应用版本', local?.version || '未知', Boolean(local?.version)],
    ['A 盘数据目录', local?.dataOnADrive && local?.dataWritable ? '可读写' : '不可用', local?.dataOnADrive && local?.dataWritable],
    ['可用磁盘空间', formatBytes(local?.disk?.freeBytes), Boolean(local?.disk)],
    ['Windows SSH / SCP', local?.sshAvailable && local?.scpAvailable ? '已就绪' : '缺失', local?.sshAvailable && local?.scpAvailable],
    ['SSH 配置', local?.sshConfigReadable ? '可读取' : '缺失或不可读', local?.sshConfigReadable],
    ['Slurm 请求', local?.slurm?.verified ? '16 CPU / 64 GB' : '脚本配置不一致', local?.slurm?.verified],
  ];
  if (remote) values.push(
    ['服务器连接', remote.connected ? remote.slurmVersion || '已连接' : '连接失败', remote.connected],
    ['Primer3 / isPCR / BLAT', remoteToolsReady
      ? `${toolVersions.primer3 || '未知'} / ${toolVersions.isPcr || '未知'} / ${toolVersions.blat || '未知'}`
      : '存在缺失', remoteToolsReady],
    ['服务器部署清单', remote.provisionManifest ? '哈希一致' : '缺失或已变化', remote.provisionManifest],
    ['服务器验证脚本', remote.runScript ? '哈希一致' : '需要部署或已变化', remote.runScript],
    ['hs1 / hg38 / mm10', remoteGenomesReady ? '索引齐全' : '存在缺失', remoteGenomesReady],
  );
  const container = $('#systemChecks');
  container.replaceChildren(...values.map(([label, detail, ok]) => {
    const item = document.createElement('div');
    item.className = `check-item ${ok ? 'ok' : 'bad'}`;
    const strong = document.createElement('strong');
    strong.textContent = `${ok ? '通过' : '注意'} · ${label}`;
    const span = document.createElement('span');
    span.textContent = String(detail);
    item.append(strong, span);
    return item;
  }));
}

async function loadLocalSystemCheck() {
  try { renderSystemCheck((await api('/api/system')).local); }
  catch (error) { showError(error); }
}

async function initialize() {
  try {
    const session = await api('/api/session');
    state.token = session.token;
    state.assemblies = session.assemblies;
    state.primer3Defaults = session.primer3.defaults;
    state.primer3Constraints = session.primer3.constraints;
    state.validationDefaults = session.validation.defaults;
    state.validationConstraints = session.validation.constraints;
    const assembly = $('#batchAssembly');
    for (const value of state.assemblies) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      assembly.append(option);
    }
    applyPrimer3Defaults();
    text($('#serverState'), '本地服务已连接');
    await loadHistory();
    await loadLocalSystemCheck();
    const restoredBatch = new URLSearchParams(window.location.search).get('batch');
    if (restoredBatch) {
      show($('#progressPanel'));
      beginPolling(restoredBatch);
    }
  } catch (error) {
    text($('#serverState'), '连接失败');
    showError(error);
  }
}

$('#fastaFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showError(new Error('文件超过 5 MiB。'));
    return;
  }
  $('#fastaText').value = await file.text();
  invalidatePreview();
  if ($('#batchName').value === 'primer_batch') {
    $('#batchName').value = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'primer_batch';
  }
});
$('#fastaText').addEventListener('input', invalidatePreview);
$('#batchAssembly').addEventListener('change', updateRunButton);
for (const id of PARAMETER_IDS) $(`#${id}`).addEventListener('input', updateRunButton);
$('#validationMaxProductSize').addEventListener('input', updateRunButton);
$('#resetPrimer3Parameters').addEventListener('click', () => { clearErrors(); applyPrimer3Defaults(); });
$('#previewButton').addEventListener('click', preview);
$('#refreshLocalCheck').addEventListener('click', loadLocalSystemCheck);
$('#checkRemote').addEventListener('click', async () => {
  const button = $('#checkRemote');
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    const local = (await api('/api/system')).local;
    const remote = (await api('/api/system/remote', { method: 'POST', body: '{}' })).remote;
    renderSystemCheck(local, remote);
  } catch (error) { showError(error); }
  finally { button.disabled = false; button.textContent = '检查服务器'; }
});

async function preview() {
  clearErrors();
  try {
    const result = await api('/api/batches/preview', {
      method: 'POST', body: JSON.stringify({ fastaText: $('#fastaText').value }),
    });
    state.preview = result;
    renderPreview(result);
  } catch (error) {
    showError(error);
  }
}

function renderPreview(result) {
  const body = $('#previewBody');
  body.replaceChildren();
  for (const record of result.records) {
    const row = document.createElement('tr');
    row.dataset.sequenceId = record.id;
    const id = document.createElement('td');
    id.textContent = record.id || '(无名称)';
    const nameCell = document.createElement('td');
    const name = document.createElement('input');
    name.value = record.displayName || record.id;
    name.maxLength = 200;
    name.dataset.role = 'display-name';
    name.dataset.sequenceId = record.id;
    nameCell.append(name);
    const length = document.createElement('td');
    length.textContent = `${record.length} bp`;
    const check = document.createElement('td');
    check.textContent = record.errors.length ? record.errors.join(' ') : '通过';
    check.className = record.errors.length ? 'bad' : 'ok';
    row.append(id, nameCell, length, check);
    body.append(row);
    name.addEventListener('input', updateRunButton);
  }
  show($('#previewPanel'));
  text($('#previewSummary'), `识别到 ${result.records.length} 条序列${result.valid ? '，序列检查通过' : '，请修正错误'}`);
  renderErrors(result.errors);
  updateRunButton();
}

$('#runButton').addEventListener('click', async () => {
  clearErrors();
  const validationErrors = collectSubmissionErrors();
  if (validationErrors.length) {
    renderErrors(validationErrors.map((message) => ({ message })));
    return;
  }
  try {
    const assignments = [...$('#previewBody').rows].map((row) => {
      const input = row.querySelector('[data-role="display-name"]');
      return { sequenceId: row.dataset.sequenceId, displayName: input.value.trim() };
    });
    const created = await api('/api/batches', {
      method: 'POST',
      body: JSON.stringify({
        fastaText: $('#fastaText').value,
        name: $('#batchName').value.trim() || 'batch',
        assembly: $('#batchAssembly').value,
        primer3Parameters: readPrimer3Parameters(),
        validationParameters: readValidationParameters(),
        assignments,
      }),
    });
    state.batchId = created.batchId;
    await startRun();
  } catch (error) {
    showError(error);
  }
});

async function startRun() {
  show($('#progressPanel'));
  show($('#retryButton'), false);
  clearReportPreview();
  await api(`/api/batches/${encodeURIComponent(state.batchId)}/run`, { method: 'POST' });
  beginPolling(state.batchId);
  await loadHistory();
}

async function startRevalidation(batchId) {
  const errors = validateValidationParameters(readValidationParameters());
  if (errors.length) {
    renderErrors(errors.map((message) => ({ message })));
    return;
  }
  show($('#progressPanel'));
  show($('#retryButton'), false);
  clearReportPreview();
  await api(`/api/batches/${encodeURIComponent(batchId)}/revalidate`, {
    method: 'POST',
    body: JSON.stringify(readValidationParameters()),
  });
  beginPolling(batchId);
  await loadHistory();
}

function stopPolling({ clearBatch = false } = {}) {
  clearTimeout(state.timer);
  state.timer = null;
  state.pollController?.abort();
  state.pollController = null;
  state.pollingActive = false;
  state.pollGeneration += 1;
  if (clearBatch) state.batchId = null;
}

function beginPolling(batchId) {
  stopPolling();
  state.batchId = batchId;
  state.pollingActive = true;
  pollStatus(state.pollGeneration);
}

async function pollStatus(generation = state.pollGeneration) {
  clearTimeout(state.timer);
  if (!state.pollingActive || !state.batchId || generation !== state.pollGeneration) return;
  const batchId = state.batchId;
  const controller = new AbortController();
  state.pollController = controller;
  let nextDelay = null;
  try {
    const status = await api(`/api/batches/${encodeURIComponent(batchId)}/status`, { signal: controller.signal });
    if (generation !== state.pollGeneration || batchId !== state.batchId) return;
    renderStatus(status);
    if (['complete', 'complete_with_warnings'].includes(status.status)) {
      await showResults(batchId);
      await loadHistory();
      state.pollingActive = false;
    } else if (status.status === 'retryable_error') {
      show($('#retryButton'));
      await loadHistory();
      state.pollingActive = false;
    } else {
      state.pollingActive = true;
      nextDelay = document.hidden ? 10000 : 2000;
    }
  } catch (error) {
    if (error.name === 'AbortError' || generation !== state.pollGeneration) return;
    text($('#progressText'), `状态读取失败：${error.message}`);
    state.pollingActive = true;
    nextDelay = document.hidden ? 10000 : 5000;
  } finally {
    if (state.pollController === controller) state.pollController = null;
    if (state.pollingActive && nextDelay !== null && generation === state.pollGeneration) {
      state.timer = setTimeout(() => pollStatus(generation), nextDelay);
    }
  }
}

function renderStatus(status) {
  const completed = status.records.filter((record) => record.stage === 'complete').length;
  const failed = status.records.filter((record) => record.stage === 'failed').length;
  const percent = status.records.length ? Math.round((completed + failed) / status.records.length * 100) : 0;
  $('#progressBar').style.width = `${percent}%`;
  $('.progress').setAttribute('aria-valuenow', String(percent));
  const run = status.run;
  const runDetail = run
    ? ` · ${run.tool}${run.assembly ? `/${run.assembly}` : ''} · Slurm ${run.jobId || '等待作业号'} · ${run.state || run.phase}${Number.isFinite(run.elapsedMs) ? ` · ${Math.round(run.elapsedMs / 1000)} 秒` : ''}`
    : '';
  text($('#progressText'), `批次 ${status.name}：${status.status}${runDetail}${status.error ? ` — ${status.error}` : ''}`);
  const container = $('#recordProgress');
  container.replaceChildren();
  for (const record of status.records) {
    const row = document.createElement('div');
    row.className = 'record';
    for (const value of [record.displayName, record.assembly, record.error || record.stage]) {
      const cell = document.createElement('span');
      cell.textContent = value;
      row.append(cell);
    }
    container.append(row);
  }
}

async function showResults(batchId = state.batchId) {
  const link = $('#reportLink');
  link.href = `/batches/${encodeURIComponent(batchId)}/report.html`;
  show(link);
  show($('#previewReportButton'));
}
$('#retryButton').addEventListener('click', startRun);

function clearReportPreview() {
  show($('#reportLink'), false);
  const preview = $('#previewReportButton');
  preview.textContent = '页面内预览';
  show(preview, false);
  const frame = $('#reportFrame');
  frame.src = 'about:blank';
  delete frame.dataset.batchId;
  show(frame, false);
}

$('#previewReportButton').addEventListener('click', () => {
  const frame = $('#reportFrame');
  if (!frame.classList.contains('hidden')) {
    frame.src = 'about:blank';
    delete frame.dataset.batchId;
    show(frame, false);
    $('#previewReportButton').textContent = '页面内预览';
    return;
  }
  frame.src = `/batches/${encodeURIComponent(state.batchId)}/report.html`;
  frame.dataset.batchId = state.batchId;
  show(frame);
  $('#previewReportButton').textContent = '关闭页面内预览';
});

document.addEventListener('visibilitychange', () => {
  if (!state.pollingActive || !state.batchId) return;
  clearTimeout(state.timer);
  if (document.hidden) {
    const generation = state.pollGeneration;
    state.timer = setTimeout(() => pollStatus(generation), 10000);
  } else {
    beginPolling(state.batchId);
  }
});

async function loadHistory() {
  const data = await api('/api/batches');
  const container = $('#history');
  container.replaceChildren();
  if (!data.batches.length) {
    text(container, '尚无批次。');
    return;
  }
  for (const batch of data.batches) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const name = document.createElement('strong');
    name.textContent = batch.name;
    const count = document.createElement('span');
    count.textContent = `${batch.sequenceCount} 条`;
    const status = document.createElement('span');
    status.textContent = batch.status;
    status.className = batch.status === 'retryable_error' ? 'status-error' : '';
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const open = document.createElement('a');
    open.className = 'button';
    open.textContent = '查看';
    open.href = `/batches/${encodeURIComponent(batch.batchId)}/report.html`;
    open.target = '_blank';
    actions.append(open);
    if (['starting', 'running', 'primer3_running', 'validation_running'].includes(batch.status)) {
      const progress = document.createElement('button');
      progress.textContent = '查看进度';
      progress.onclick = () => {
        window.history.replaceState(null, '', `?batch=${encodeURIComponent(batch.batchId)}`);
        show($('#progressPanel'));
        beginPolling(batch.batchId);
      };
      actions.append(progress);
    }
    if (batch.status === 'retryable_error' || batch.status === 'prepared') {
      const retry = document.createElement('button');
      retry.textContent = '运行';
      retry.onclick = async () => {
        state.batchId = batch.batchId;
        try { await startRun(); } catch (error) { showError(error); }
      };
      actions.append(retry);
    }
    if (['complete', 'complete_with_warnings'].includes(batch.status)) {
      const revalidate = document.createElement('button');
      revalidate.textContent = '重新验证';
      revalidate.title = '按页面当前的基因组 isPCR 最大产物长度重新验证，保留旧原始结果';
      revalidate.onclick = async () => {
        if (!window.confirm(`按 0–${readValidationParameters().maxProductSize} bp 重新验证批次 ${batch.name}？`)) return;
        try { await startRevalidation(batch.batchId); } catch (error) { showError(error); }
      };
      actions.append(revalidate);
    }
    if (!['starting', 'running', 'primer3_running', 'validation_running'].includes(batch.status)) {
      const remove = document.createElement('button');
      remove.textContent = '删除';
      remove.className = 'danger-button';
      remove.title = '将整个批次目录移入 Windows 回收站，可从回收站恢复';
      remove.onclick = async () => {
        const description = `批次“${batch.name}”（${batch.sequenceCount} 条序列）`;
        if (!window.confirm(`删除${description}？\n\n整个批次目录将移入 Windows 回收站，可以恢复。`)) return;
        if (!window.confirm(`请再次确认：将${description}移入回收站？`)) return;
        try {
          await api(`/api/batches/${encodeURIComponent(batch.batchId)}/delete`, {
            method: 'POST',
            body: JSON.stringify({ confirmation: batch.batchId }),
          });
          if (state.batchId === batch.batchId) {
            stopPolling({ clearBatch: true });
            clearReportPreview();
            show($('#progressPanel'), false);
            text($('#progressText'), '');
            $('#recordProgress').replaceChildren();
            $('#progressBar').style.width = '0%';
            $('.progress').setAttribute('aria-valuenow', '0');
            window.history.replaceState(null, '', window.location.pathname);
          }
          clearErrors();
          await loadHistory();
        } catch (error) { showError(error); }
      };
      actions.append(remove);
    }
    row.append(name, count, status, actions);
    container.append(row);
  }
}
$('#refreshHistory').addEventListener('click', loadHistory);

async function sendShutdown(afterCurrent) {
  const outcome = await api('/api/app/shutdown', {
    method: 'POST', body: JSON.stringify({ afterCurrent }),
  });
  $('#exitButton').disabled = true;
  if (outcome.status === 'shutdown_pending') {
    text($('#exitState'), '当前任务完成后将自动退出。');
  } else {
    clearTimeout(state.timer);
    text($('#serverState'), '软件正在关闭');
    text($('#exitState'), '服务已关闭后即可关闭此页面。');
  }
}

$('#exitButton').addEventListener('click', async () => {
  if (!window.confirm('确认退出本地引物设计软件吗？关闭浏览器页面本身不会停止服务。')) return;
  try {
    await sendShutdown(false);
  } catch (error) {
    if (error.status !== 409) {
      showError(error);
      return;
    }
    if (!window.confirm('当前有任务正在运行。是否在任务完成并保存状态后自动退出？')) return;
    try { await sendShutdown(true); } catch (pendingError) { showError(pendingError); }
  }
});

initialize();
