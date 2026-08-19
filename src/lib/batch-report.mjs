import { GLASS_THEME_ID, renderGlassThemeCss } from './themes.mjs';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tsvSafe(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function resultFor(results, candidate) {
  const stored = results?.[candidate.candidateId];
  return stored?.[candidate.assembly] || (stored?.assembly === candidate.assembly ? stored : null);
}

export const MAX_DISPLAYED_GENOMIC_PRODUCTS = 5;

function displayedProductText(products, formatter) {
  const values = products.slice(0, MAX_DISPLAYED_GENOMIC_PRODUCTS).map(formatter);
  if (products.length > MAX_DISPLAYED_GENOMIC_PRODUCTS) {
    values.push(`…（仅显示前 ${MAX_DISPLAYED_GENOMIC_PRODUCTS} 个，共 ${products.length} 个）`);
  }
  return values.join('; ');
}

export const CLASSIFICATION_LABELS = Object.freeze({
  pass_single_product: '唯一产物',
  fail_multiple_loci: '多位点',
  no_product: '无产物',
  review_patch_or_alt: '需复核',
  review_non_primary_only: '需复核',
  service_error: '验证失败',
  parse_error: '验证失败',
  validation_error: '验证失败',
  pending: '待验证',
});

function classificationLabel(classification) {
  if (CLASSIFICATION_LABELS[classification]) return CLASSIFICATION_LABELS[classification];
  return /error|failed/i.test(String(classification)) ? '验证失败' : '需复核';
}

function warningText(candidate, result, extraWarnings = []) {
  const values = [
    ...(Array.isArray(candidate.warnings) ? candidate.warnings : []),
    ...(Array.isArray(result?.warnings) ? result.warnings : []),
    result?.error,
    ...extraWarnings,
  ].filter(Boolean);
  return [...new Set(values)].join('; ');
}

function inputTemplatePositions(candidate, source) {
  const empty = {
    forward_input_start_1based: '',
    forward_input_end_1based: '',
    reverse_input_start_1based: '',
    reverse_input_end_1based: '',
  };
  const required = [
    candidate.forwardPosition,
    candidate.forwardLength,
    candidate.reversePosition,
    candidate.reverseLength,
    source?.length,
  ];
  if (required.some((value) => value === undefined || value === null || value === '')) {
    return { ...empty, warning: '模板坐标未记录' };
  }
  const [forwardStart0, forwardLength, reverseStart0, reverseLength, templateLength] = required;
  if (![forwardStart0, reverseStart0, templateLength].every((value) => Number.isSafeInteger(value) && value >= 0)
    || ![forwardLength, reverseLength, templateLength].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return { ...empty, warning: '模板坐标异常' };
  }
  const forwardStart1 = forwardStart0 + 1;
  const forwardEnd1 = forwardStart0 + forwardLength;
  const reverseStart1 = reverseStart0 + 1;
  const reverseEnd1 = reverseStart0 + reverseLength;
  if (![forwardStart1, forwardEnd1, reverseStart1, reverseEnd1].every(Number.isSafeInteger)
    || forwardEnd1 > templateLength || reverseEnd1 > templateLength) {
    return { ...empty, warning: '模板坐标异常' };
  }
  return {
    forward_input_start_1based: forwardStart1,
    forward_input_end_1based: forwardEnd1,
    reverse_input_start_1based: reverseStart1,
    reverse_input_end_1based: reverseEnd1,
    warning: '',
  };
}

export function buildBatchRows({ batch, candidates, results = {} }) {
  if (candidates.some((candidate) => candidate.engine !== 'primer3')) {
    throw new Error('Batch reports support Primer3 candidates only.');
  }
  const records = new Map((batch?.records || []).map((record) => [record.sequenceId, record]));
  return candidates.map((candidate) => {
    const result = resultFor(results, candidate);
    const classification = result?.classification || 'pending';
    const products = (result?.products || []).map((product) => ({
      location: `${product.contig}:${product.start1}-${product.end1}`,
      productSize: product.productSize,
      contigClass: product.contigClass || '',
    }));
    const source = records.get(candidate.sequenceId);
    const templatePositions = inputTemplatePositions(candidate, source);
    return {
      sequenceId: candidate.sequenceId,
      displayName: source?.displayName || source?.header || candidate.sequenceId,
      templateLengthBp: source?.length ?? '',
      assembly: candidate.assembly,
      engine: 'primer3',
      candidateId: candidate.candidateId,
      pairRank: candidate.pairRank,
      forwardPrimer: candidate.forwardSequence,
      reversePrimer: candidate.reverseSequence,
      forward_input_start_1based: templatePositions.forward_input_start_1based,
      forward_input_end_1based: templatePositions.forward_input_end_1based,
      reverse_input_start_1based: templatePositions.reverse_input_start_1based,
      reverse_input_end_1based: templatePositions.reverse_input_end_1based,
      forwardTm: candidate.forwardTm ?? '',
      reverseTm: candidate.reverseTm ?? '',
      forwardGc: candidate.forwardGc ?? '',
      reverseGc: candidate.reverseGc ?? '',
      productLengthDesign: candidate.productLength ?? '',
      templateProductLengthBp: candidate.productLength ?? '',
      scoreType: 'Primer3 penalty',
      score: candidate.pairPenalty,
      classification,
      classificationLabel: classificationLabel(classification),
      validationProductCount: result ? products.length : '',
      genomicProductLengths: displayedProductText(products, (product) => product.productSize),
      genomicProductLengthsBp: products.slice(0, MAX_DISPLAYED_GENOMIC_PRODUCTS)
        .map((product) => product.productSize),
      genomicProductLocations: displayedProductText(products, (product) => product.location),
      genomicProductClasses: displayedProductText(products, (product) => product.contigClass),
      validationProducts: displayedProductText(
        products,
        (product) => `${product.location} (${product.productSize} bp${product.contigClass ? `, ${product.contigClass}` : ''})`,
      ),
      warnings: warningText(candidate, result, templatePositions.warning ? [templatePositions.warning] : []),
    };
  });
}

export function summarizeBatch({ batch, candidates, results = {} }) {
  const rows = buildBatchRows({ batch, candidates, results });
  return {
    sequenceCount: batch.records.length,
    candidateCount: rows.length,
    engines: {
      primer3: {
        candidateCount: rows.length,
        passSingleProduct: rows.filter((row) => row.classification === 'pass_single_product').length,
        multipleLoci: rows.filter((row) => row.classification === 'fail_multiple_loci').length,
        noProduct: rows.filter((row) => row.classification === 'no_product').length,
        review: rows.filter((row) => row.classificationLabel === '需复核').length,
        failed: rows.filter((row) => row.classificationLabel === '验证失败').length,
        pending: rows.filter((row) => row.classification === 'pending').length,
      },
    },
  };
}

export const BATCH_TABLE_HEADERS = Object.freeze([
  'sequence_id', 'display_name', 'input_template_length_bp', 'assembly', 'engine', 'candidate_id', 'pair_rank',
  'forward_primer', 'forward_input_start_1based', 'forward_input_end_1based',
  'reverse_primer', 'reverse_input_start_1based', 'reverse_input_end_1based',
  'forward_tm', 'reverse_tm', 'forward_gc', 'reverse_gc',
  'product_length_design', 'score_type', 'score', 'validation_classification',
  'validation_product_count', 'genomic_product_lengths_bp', 'genomic_product_locations',
  'genomic_product_classes', 'validation_products', 'warnings',
]);

function rowValues(row) {
  return [
    row.sequenceId, row.displayName, row.templateLengthBp, row.assembly, row.engine, row.candidateId, row.pairRank,
    row.forwardPrimer, row.forward_input_start_1based, row.forward_input_end_1based,
    row.reversePrimer, row.reverse_input_start_1based, row.reverse_input_end_1based,
    row.forwardTm, row.reverseTm, row.forwardGc, row.reverseGc,
    row.productLengthDesign, row.scoreType, row.score, row.classificationLabel,
    row.validationProductCount, row.genomicProductLengths, row.genomicProductLocations,
    row.genomicProductClasses, row.validationProducts, row.warnings,
  ];
}

export function renderBatchCsv({ batch = { records: [] }, candidates, results = {} }) {
  const rows = buildBatchRows({ batch, candidates, results });
  const lines = [BATCH_TABLE_HEADERS.join(','), ...rows.map((row) => rowValues(row).map(csvCell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function renderBatchTsv({ batch = { records: [] }, candidates, results = {} }) {
  const rows = buildBatchRows({ batch, candidates, results });
  return [BATCH_TABLE_HEADERS.join('\t'), ...rows.map((row) => rowValues(row).map(tsvSafe).join('\t'))].join('\r\n');
}

function options(values) {
  return [...new Set(values)].sort().map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
}

function recorded(value) {
  return value === undefined || value === null || value === '' ? '未记录' : value;
}

function recordedRange(minimum, maximum, suffix = '') {
  if (minimum === undefined || minimum === null || minimum === ''
    || maximum === undefined || maximum === null || maximum === '') {
    return '未记录';
  }
  return `${minimum}–${maximum}${suffix}`;
}

function designSettings(batch, config) {
  const web = batch?.designSettings?.primer3;
  const validation = batch?.designSettings?.validation;
  const internal = config?.primer3?.parameters;
  const assemblies = [...new Set((batch?.records || []).map((record) => record.assembly).filter(Boolean))];
  const assembly = batch?.assembly || batch?.designSettings?.assembly
    || (assemblies.length === 1 ? assemblies[0] : (assemblies.length > 1 ? `混合（${assemblies.join('、')}）` : null));
  return {
    assembly: recorded(assembly),
    numReturn: recorded(web?.numReturn ?? internal?.numReturn),
    tm: web
      ? `${web.tmTargetC} ± ${web.tmToleranceC}°C（${web.tmTargetC - web.tmToleranceC}–${web.tmTargetC + web.tmToleranceC}°C）`
      : (internal ? `${recorded(internal.tmOptC)}°C（${recorded(internal.tmMinC)}–${recorded(internal.tmMaxC)}°C）` : '未记录'),
    primerLength: web
      ? `${web.primerLengthMin} / ${web.primerLengthOpt} / ${web.primerLengthMax} bp`
      : (internal ? `${recorded(internal.primerLengthMin)} / ${recorded(internal.primerLengthOpt)} / ${recorded(internal.primerLengthMax)} bp` : '未记录'),
    productSize: web
      ? `${web.productSizeMin}–${web.productSizeMax} bp`
      : (internal ? recordedRange(internal.productSizeMin, internal.productSizeMax, ' bp') : '未记录'),
    validationSize: validation
      ? `${validation.minProductSize}–${validation.maxProductSize} bp`
      : (config?.ucsc && Object.hasOwn(config.ucsc, 'maxProductSize')
        ? `${recorded(config.ucsc.minProductSize ?? internal?.productSizeMin)}–${recorded(config.ucsc.maxProductSize)} bp`
        : '未记录'),
    validationParallelism: recorded(validation?.parallelism ?? config?.ucsc?.parallelism),
    gc: web
      ? `${web.gcMinPercent}–${web.gcMaxPercent}%`
      : (internal ? recordedRange(internal.gcMinPercent, internal.gcMaxPercent, '%') : '未记录'),
  };
}

export function renderBatchReport({ batch, candidates, results = {}, config = null }) {
  const summary = summarizeBatch({ batch, candidates, results });
  const dataRows = buildBatchRows({ batch, candidates, results });
  const settings = designSettings(batch, config);
  const settingsCard = `<section class="card settings-card"><h2>本批设计设置</h2><div><strong>基因组</strong> ${escapeHtml(settings.assembly)}</div><div><strong>候选引物对</strong> ${escapeHtml(settings.numReturn)}</div><div><strong>Tm</strong> ${escapeHtml(settings.tm)}</div><div><strong>引物长度</strong> ${escapeHtml(settings.primerLength)}</div><div><strong>模板产物范围</strong> ${escapeHtml(settings.productSize)}</div><div><strong>基因组验证范围</strong> ${escapeHtml(settings.validationSize)}</div><div><strong>isPCR 并发</strong> ${escapeHtml(settings.validationParallelism)}</div><div><strong>GC</strong> ${escapeHtml(settings.gc)}</div></section>`;
  const value = summary.engines.primer3;
  const cards = `<section class="card"><h2>Primer3</h2><div>候选 ${value.candidateCount}</div><div>唯一产物 ${value.passSingleProduct}</div><div>多位点 ${value.multipleLoci}</div><div>无产物 ${value.noProduct}</div><div>需复核 ${value.review}</div><div>验证失败 ${value.failed}</div><div>待验证 ${value.pending}</div></section>`;
  const rows = dataRows.map((row) => {
    const cells = rowValues(row);
    const rendered = cells.map((value, index) => {
      const header = BATCH_TABLE_HEADERS[index];
      const code = header === 'forward_primer' || header === 'reverse_primer';
      return `<td data-copy="${escapeHtml(tsvSafe(value))}" data-sort="${escapeHtml(value)}">${code ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)}</td>`;
    }).join('');
    return `<tr data-sequence="${escapeHtml(row.sequenceId)}" data-assembly="${escapeHtml(row.assembly)}" data-classification="${escapeHtml(row.classificationLabel)}" data-rank="${escapeHtml(row.pairRank)}"><td class="select"><input type="checkbox" aria-label="选择 ${escapeHtml(row.candidateId)}"></td>${rendered}</tr>`;
  }).join('\n');
  const headings = ['', ...BATCH_TABLE_HEADERS].map((value, index) => index === 0
    ? '<th class="select">选择</th>'
    : `<th><button class="sort" data-column="${index}">${escapeHtml(value)}</button></th>`).join('');

  return `<!doctype html>
<html lang="zh-CN" data-theme="${GLASS_THEME_ID}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>批量引物设计与特异性验证 - ${escapeHtml(batch.name)}</title>
<style>
${renderGlassThemeCss()}
*{box-sizing:border-box}html,body{height:100%;overflow:hidden;background:#eef4fb}body{margin:0;padding:14px;display:grid;grid-template-rows:auto auto auto auto minmax(0,1fr);gap:8px;font-family:var(--font-body);color:var(--text);background:var(--page-bg)}h1,h2{font-family:var(--font-heading)}.report-head h1{margin:0 0 4px}.report-note{margin:0}.muted{color:var(--muted)}button,a,select,input{font:inherit;border:1px solid var(--border);border-radius:calc(var(--radius) * .6);padding:7px 9px;background:var(--input-bg);color:var(--text)}button,a{cursor:pointer}button:hover,a:hover{border-color:var(--primary)}button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid color-mix(in srgb,var(--primary) 38%,transparent);outline-offset:2px}.primary{background:var(--primary)!important;color:var(--primary-contrast)!important;border-color:var(--primary)!important}.cards{display:flex;gap:8px;flex-wrap:wrap;min-height:0}.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:9px 12px;min-width:180px;box-shadow:var(--shadow)}.card h2{font-size:15px;margin:0 0 5px}.settings-card{min-width:min(100%,360px);line-height:1.45}.settings-card strong{display:inline-block;min-width:88px;color:var(--primary)}.toolbar{display:flex;gap:7px;flex-wrap:wrap;align-items:end;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:9px 11px;box-shadow:var(--shadow)}.toolbar label{display:grid;gap:3px;font-size:12px}.toolbar a{text-decoration:none}.top-scroll{overflow-x:auto;overflow-y:hidden;height:16px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.top-scroll-track{height:1px}.table-wrap{min-height:0;overflow:auto;border:1px solid var(--border);border-radius:calc(var(--radius) * .7);background:var(--surface);overscroll-behavior:contain}table{border-collapse:collapse;width:max-content;min-width:100%;background:var(--surface);font-size:12px}th,td{border-bottom:1px solid color-mix(in srgb,var(--text) 12%,transparent);border-right:1px solid color-mix(in srgb,var(--text) 10%,transparent);padding:var(--table-pad);vertical-align:top;text-align:left;max-width:280px;word-break:break-word}th{background:var(--table-head);position:sticky;top:0;z-index:1;white-space:nowrap}.sort{border:0;background:transparent;font-weight:600;cursor:pointer;padding:0;color:var(--text)}.select{min-width:45px;text-align:center}code{font-family:var(--font-mono);font-size:11px}.hidden{display:none}#message{min-height:20px;color:var(--primary)}@media(max-width:760px){body{padding:8px}.cards{flex-wrap:nowrap;overflow-x:auto}.toolbar{flex-wrap:nowrap;overflow-x:auto}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.001ms!important;animation-duration:.001ms!important}}
</style></head><body>
<div class="report-head"><h1>批量引物设计与特异性验证</h1><div class="muted">批次 ${escapeHtml(batch.name)} · 序列 ${summary.sequenceCount} · 候选 ${summary.candidateCount}</div></div>
<p class="muted report-note">输入序列坐标采用 1-based 闭区间；反向引物序列按 5′→3′显示，坐标区间按输入模板从小到大排列。</p>
<div class="cards">${settingsCard}${cards}</div>
<div class="toolbar">
<label>序列<select id="sequenceFilter"><option value="">全部</option>${options(dataRows.map((row) => row.sequenceId))}</select></label>
<label>assembly<select id="assemblyFilter"><option value="">全部</option>${options(dataRows.map((row) => row.assembly))}</select></label>
<label>验证结论<select id="classificationFilter"><option value="">全部</option>${options(dataRows.map((row) => row.classificationLabel))}</select></label>
<label>最大排名<input id="rankFilter" type="number" min="1" placeholder="不限"></label>
<button id="copyAll">复制全部</button><button id="copyFiltered">复制筛选结果</button><button id="copySelected" class="primary">复制选中行</button>
<a href="summary.csv" download>下载 CSV</a><span id="message" role="status"></span>
</div>
<div class="top-scroll" id="topScroll" aria-label="表格顶部横向滚动条"><div class="top-scroll-track" id="topScrollTrack"></div></div>
<div class="table-wrap" id="tableWrap"><table id="results"><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table></div>
<script>
const table=document.querySelector('#results');const body=table.tBodies[0];const headers=${JSON.stringify(BATCH_TABLE_HEADERS)};
const filters={sequence:document.querySelector('#sequenceFilter'),assembly:document.querySelector('#assemblyFilter'),classification:document.querySelector('#classificationFilter'),rank:document.querySelector('#rankFilter')};
const tableWrap=document.querySelector('#tableWrap'),topScroll=document.querySelector('#topScroll'),topTrack=document.querySelector('#topScrollTrack');let syncing=false;function updateTopScroll(){topTrack.style.width=table.scrollWidth+'px';topScroll.scrollLeft=tableWrap.scrollLeft}topScroll.addEventListener('scroll',()=>{if(syncing)return;syncing=true;tableWrap.scrollLeft=topScroll.scrollLeft;syncing=false});tableWrap.addEventListener('scroll',()=>{if(syncing)return;syncing=true;topScroll.scrollLeft=tableWrap.scrollLeft;syncing=false});const resizeObserver=new ResizeObserver(updateTopScroll);resizeObserver.observe(table);resizeObserver.observe(tableWrap);window.addEventListener('resize',updateTopScroll);
function visibleRows(){return [...body.rows].filter(row=>!row.classList.contains('hidden'))}function applyFilters(){for(const row of body.rows){const ok=(!filters.sequence.value||row.dataset.sequence===filters.sequence.value)&&(!filters.assembly.value||row.dataset.assembly===filters.assembly.value)&&(!filters.classification.value||row.dataset.classification===filters.classification.value)&&(!filters.rank.value||Number(row.dataset.rank)<=Number(filters.rank.value));row.classList.toggle('hidden',!ok)}requestAnimationFrame(updateTopScroll)}Object.values(filters).forEach(control=>control.addEventListener('input',applyFilters));
function values(row){return [...row.cells].slice(1).map(cell=>(cell.dataset.copy||'').replace(/[\\t\\r\\n]+/g,' '))}function makeTsv(rows){return [headers.join('\\t'),...rows.map(row=>values(row).join('\\t'))].join('\\r\\n')}
async function copyRows(rows){if(!rows.length){show('没有可复制的行');return}const text=makeTsv(rows);try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove()}show('已复制 '+rows.length+' 行，可直接粘贴到 Excel')}
function show(text){const node=document.querySelector('#message');node.textContent=text;setTimeout(()=>{if(node.textContent===text)node.textContent=''},4000)}
document.querySelector('#copyAll').onclick=()=>copyRows([...body.rows]);document.querySelector('#copyFiltered').onclick=()=>copyRows(visibleRows());document.querySelector('#copySelected').onclick=()=>copyRows([...body.rows].filter(row=>row.querySelector('input').checked));
let sortState={column:-1,direction:1};document.querySelectorAll('.sort').forEach(button=>button.addEventListener('click',()=>{const column=Number(button.dataset.column);sortState.direction=sortState.column===column?-sortState.direction:1;sortState.column=column;const rows=[...body.rows];rows.sort((a,b)=>{const av=a.cells[column].dataset.sort||'',bv=b.cells[column].dataset.sort||'';const an=Number(av),bn=Number(bv);const result=av!==''&&bv!==''&&Number.isFinite(an)&&Number.isFinite(bn)?an-bn:av.localeCompare(bv,'zh-CN',{numeric:true});return result*sortState.direction});rows.forEach(row=>body.append(row));requestAnimationFrame(updateTopScroll)}));requestAnimationFrame(updateTopScroll);
</script></body></html>`;
}
