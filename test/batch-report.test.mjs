import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_TABLE_HEADERS,
  buildBatchRows,
  MAX_DISPLAYED_GENOMIC_PRODUCTS,
  renderBatchCsv,
  renderBatchReport,
  renderBatchTsv,
  summarizeBatch,
} from '../src/lib/batch-report.mjs';

const batch = {
  name: 'pilot <safe>',
  assembly: 'hs1',
  designSettings: {
    assembly: 'hs1',
    primer3: {
      numReturn: 5, tmTargetC: 60, tmToleranceC: 5,
      primerLengthMin: 18, primerLengthOpt: 23, primerLengthMax: 28,
      productSizeMin: 80, productSizeMax: 1000, gcMinPercent: 40, gcMaxPercent: 60,
    },
    validation: { minProductSize: 0, maxProductSize: 10000, parallelism: 4 },
  },
  records: [{ sequenceId: 'a', displayName: '样本 A <script>', assembly: 'hs1', length: 100 }],
};
const candidates = [
  { sequenceId: 'a', assembly: 'hs1', engine: 'primer3', candidateId: 'a.p3.01', pairRank: 1, forwardSequence: 'ACGT', reverseSequence: 'TGCA', forwardPosition: 0, reversePosition: 96, forwardLength: 4, reverseLength: 4, forwardTm: 60.1, reverseTm: 59.9, forwardGc: 50, reverseGc: 50, productLength: 100, pairPenalty: 0.2 },
  { sequenceId: 'a', assembly: 'hs1', engine: 'primer3', candidateId: 'a.p3.02', pairRank: 2, forwardSequence: 'ACGT', reverseSequence: 'TGCA', forwardPosition: 4, reversePosition: 92, forwardLength: 4, reverseLength: 4, pairPenalty: 0.4 },
];
const results = { 'a.p3.01': { hs1: {
  classification: 'pass_single_product',
  products: [{ contig: 'chr1', start1: 1, end1: 100, productSize: 100, contigClass: 'primary' }],
  blatSummary: { forwardHits: 3, reverseHits: 2, forwardFullLengthExact: 1, reverseFullLengthExact: 1 },
} } };

test('batch report summarizes the Primer3-only workflow', () => {
  const summary = summarizeBatch({ batch, candidates, results });
  assert.equal(summary.engines.primer3.passSingleProduct, 1);
  assert.equal(summary.engines.primer3.pending, 1);
  const html = renderBatchReport({ batch, candidates, results });
  assert.match(html, /批量引物设计与特异性验证/);
  assert.match(html, /复制筛选结果/);
  assert.match(html, /summary\.csv/);
  assert.match(html, /href="input\.fasta" download>下载原始 FASTA/);
  assert.match(html, /data-theme="glass-laboratory"/);
  assert.match(html, /本批设计设置/);
  assert.match(html, /候选引物对<\/strong> 5/);
  assert.match(html, /60 ± 5°C/);
  assert.match(html, /基因组验证范围/);
  assert.match(html, /0–10000 bp/);
  assert.match(html, /isPCR 并发<\/strong> 4/);
  assert.match(html, /id="topScroll"/);
  assert.match(html, /id="tableWrap"/);
  assert.match(html, /ResizeObserver/);
  assert.match(html, /html,body\{height:100%;overflow:hidden/);
  assert.match(html, /body\{margin:0;padding:6px;/);
  assert.match(html, /\.cards\{display:grid;grid-template-columns:minmax\(0,2fr\) minmax\(0,1fr\)/);
  assert.match(html, /\.card\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(html, /\.toolbar\{display:flex;gap:5px;flex-wrap:nowrap/);
  assert.doesNotMatch(html, /max-height:70vh/);
  assert.match(html, /输入序列坐标采用 1-based 闭区间/);
  assert.doesNotMatch(html, /themeDialog|themeButton|data-theme-choice|localStorage/);
  assert.doesNotMatch(html, /href="\/themes\.css"/);
  assert.doesNotMatch(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /backdrop-filter|background-attachment\s*:\s*fixed/);
  assert.doesNotMatch(html, /样本 A <script>/);
  assert.match(html, /样本 A &lt;script&gt;/);
});

test('legacy report shows recorded 11-pair and mixed-assembly settings without inventing GC values', () => {
  const legacyBatch = {
    name: 'legacy',
    records: [
      { sequenceId: 'a', displayName: 'A', assembly: 'hs1' },
      { sequenceId: 'b', displayName: 'B', assembly: 'mm10' },
    ],
  };
  const config = {
    primer3: {
      parameters: {
        numReturn: 11, tmMinC: 55, tmOptC: 60, tmMaxC: 65,
        primerLengthMin: 18, primerLengthOpt: 23, primerLengthMax: 28,
        productSizeMin: 80, productSizeMax: 1000,
      },
      server: { remoteRoot: '/secret/server/path' },
    },
  };
  const html = renderBatchReport({ batch: legacyBatch, candidates: [], results: {}, config });
  assert.match(html, /混合（hs1、mm10）/);
  assert.match(html, /候选引物对<\/strong> 11/);
  assert.match(html, /GC<\/strong> 未记录/);
  assert.doesNotMatch(html, /未记录–未记录%/);
  assert.doesNotMatch(html, /secret\/server/);
});

test('Primer3-only report renders one engine card and maps classifications to Chinese', () => {
  const html = renderBatchReport({ batch, candidates: candidates.slice(0, 1), results });
  assert.match(html, /<h2>Primer3<\/h2>/);
  assert.equal((html.match(/<h2>Primer3<\/h2>/g) || []).length, 1);
  assert.match(html, /唯一产物/);
});

test('CSV has an Excel UTF-8 BOM and pending product count stays blank', () => {
  const csv = renderBatchCsv({ batch, candidates, results });
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.match(csv, /a\.p3\.01/);
  const pendingLine = csv.split('\r\n').find((line) => line.includes('a.p3.02'));
  const pendingCells = pendingLine.split(',');
  assert.equal(pendingCells[BATCH_TABLE_HEADERS.indexOf('product_count')], '');
  assert.equal(pendingCells[BATCH_TABLE_HEADERS.indexOf('validation_classification')], '待验证');
  const tsv = renderBatchTsv({ batch, candidates: candidates.slice(0, 1), results });
  assert.equal(tsv.split('\r\n')[0].split('\t').length, tsv.split('\r\n')[1].split('\t').length);
});

test('normalized report rows contain only the requested final-report columns', () => {
  const [row] = buildBatchRows({ batch, candidates: candidates.slice(0, 1), results });
  assert.deepEqual(BATCH_TABLE_HEADERS, [
    'sequence_id', 'display_name', 'candidate_id', 'rank', 'forward_primer', 'reverse_primer',
    'F_start_end', 'R_start_end', 'genomic_pcr_length', 'design_length', 'product_count',
    'validation_classification', 'input_length', 'genomic_product_locations', 'assembly',
    'forward_tm', 'reverse_tm', 'forward_gc', 'reverse_gc', 'score',
    'genomic_product_classes', 'validation_products', 'warnings',
  ]);
  assert.deepEqual(Object.keys(row), BATCH_TABLE_HEADERS);
  assert.equal(row.display_name, '样本 A <script>');
  assert.match(row.validation_products, /primary/);
  assert.equal(row.genomic_pcr_length, '100');
  assert.equal(row.genomic_product_locations, 'chr1:1-100');
  assert.equal(Object.hasOwn(row, 'blatForwardHits'), false);
  assert.equal(Object.hasOwn(row, 'blatReviewStatus'), false);
  assert.equal(Object.hasOwn(row, 'engine'), false);
  assert.equal(Object.hasOwn(row, 'score_type'), false);
  assert.equal(row.input_length, 100);
  assert.equal(row.F_start_end, '1-4');
  assert.equal(row.R_start_end, '97-100');
  assert.equal(row.warnings, '');
  assert.ok(renderBatchCsv({ batch, candidates: candidates.slice(0, 1), results }).includes('genomic_pcr_length'));
});

test('multi-locus results keep the total count but display only the first five products', () => {
  const products = Array.from({ length: 7 }, (_, index) => ({
    contig: `chr${index + 1}`,
    start1: index * 100 + 1,
    end1: index * 100 + 50,
    productSize: 50 + index,
    contigClass: index === 5 ? 'alt' : 'primary',
  }));
  const multiResults = {
    'a.p3.01': { hs1: { classification: 'fail_multiple_loci', products } },
  };
  const [row] = buildBatchRows({ batch, candidates: candidates.slice(0, 1), results: multiResults });
  const csv = renderBatchCsv({ batch, candidates: candidates.slice(0, 1), results: multiResults });
  const tsv = renderBatchTsv({ batch, candidates: candidates.slice(0, 1), results: multiResults });
  const html = renderBatchReport({ batch, candidates: candidates.slice(0, 1), results: multiResults });

  assert.equal(MAX_DISPLAYED_GENOMIC_PRODUCTS, 5);
  assert.equal(row.product_count, 7);
  assert.match(row.genomic_pcr_length, /^50; 51; 52; 53; 54;/);
  assert.match(row.genomic_product_locations, /chr5:401-450/);
  assert.doesNotMatch(row.genomic_product_locations, /chr6:501-550|chr7:601-650/);
  assert.match(row.genomic_product_locations, /仅显示前 5 个，共 7 个/);
  for (const output of [csv, tsv, html]) {
    assert.match(output, /仅显示前 5 个/);
    assert.doesNotMatch(output, /chr6:501-550|chr7:601-650/);
  }
});

test('template positions fail closed when Primer3 coordinates are missing, malformed, or out of range', () => {
  const base = candidates[0];
  const cases = [
    [{ ...base, forwardPosition: undefined }, '模板坐标未记录'],
    [{ ...base, forwardPosition: -1 }, '模板坐标异常'],
    [{ ...base, reversePosition: 97 }, '模板坐标异常'],
    [{ ...base, forwardLength: 4.5 }, '模板坐标异常'],
  ];
  for (const [candidate, warning] of cases) {
    const [row] = buildBatchRows({ batch, candidates: [candidate], results: {} });
    assert.equal(row.F_start_end, '');
    assert.equal(row.R_start_end, '');
    assert.match(row.warnings, new RegExp(warning));
  }
});

test('HTML, CSV, and TSV expose the same combined 1-based input-template intervals', () => {
  const positionHeaders = ['F_start_end', 'R_start_end'];
  const csv = renderBatchCsv({ batch, candidates: candidates.slice(0, 1), results });
  const tsv = renderBatchTsv({ batch, candidates: candidates.slice(0, 1), results });
  const html = renderBatchReport({ batch, candidates: candidates.slice(0, 1), results });
  const csvHeaders = csv.slice(1).split('\r\n')[0].split(',');
  const tsvHeaders = tsv.split('\r\n')[0].split('\t');
  for (const header of positionHeaders) {
    assert.ok(csvHeaders.includes(header));
    assert.ok(tsvHeaders.includes(header));
    assert.match(html, new RegExp(`>${header}<`));
  }
  assert.match(csv, /ACGT,TGCA,1-4,97-100,/);
  assert.equal(tsv.split('\r\n')[1].split('\t').length, tsvHeaders.length);
});

test('derived batch results hide BLAT fields while preserving isPCR classifications and products', () => {
  const [row] = buildBatchRows({ batch, candidates: candidates.slice(0, 1), results });
  const csv = renderBatchCsv({ batch, candidates: candidates.slice(0, 1), results });
  const tsv = renderBatchTsv({ batch, candidates: candidates.slice(0, 1), results });
  const html = renderBatchReport({ batch, candidates: candidates.slice(0, 1), results });
  for (const key of [
    'blatForwardHits', 'blatReverseHits', 'blatForwardFullLengthExact',
    'blatReverseFullLengthExact', 'blatReviewStatus',
  ]) assert.equal(Object.hasOwn(row, key), false, key);
  for (const output of [csv, tsv, html]) {
    assert.doesNotMatch(output, /blat_forward_hits|blat_reverse_hits|blat_forward_full_length_exact|blat_reverse_full_length_exact|blat_review_status/i);
  }
  assert.equal(row.validation_classification, '唯一产物');
  assert.equal(row.genomic_product_locations, 'chr1:1-100');
  assert.match(html, /唯一产物/);
  assert.match(html, /chr1:1-100/);
});

test('batch report fails closed for candidates from a retired design engine', () => {
  assert.throws(
    () => buildBatchRows({ batch, candidates: [{ ...candidates[0], engine: 'legacy' }], results }),
    /Primer3 candidates only/,
  );
});
