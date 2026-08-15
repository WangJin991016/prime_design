import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHgPcrUrl,
  classifyContig,
  classifyProducts,
  parseHgPcrHtml,
} from '../src/lib/ucsc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidate = {
  candidateId: 'pair-001',
  forwardSequence: 'GACCTCGGCGTGGCCTAGCG',
  reverseSequence: 'CTGCTCCTGCTGATGATCTG',
};

test('buildHgPcrUrl uses current UCSC form parameter names', () => {
  const url = new URL(buildHgPcrUrl(candidate, {
    baseUrl: 'https://genome.ucsc.edu',
    assembly: 'hg38',
    target: 'genome',
    maxProductSize: 1000,
    minPerfect: 15,
    minGood: 15,
    flipReverse: false,
  }));
  assert.equal(url.pathname, '/cgi-bin/hgPcr');
  assert.equal(url.searchParams.get('db'), 'hg38');
  assert.equal(url.searchParams.get('wp_f'), candidate.forwardSequence);
  assert.equal(url.searchParams.get('wp_r'), candidate.reverseSequence);
  assert.equal(url.searchParams.get('wp_size'), '1000');
});

test('parseHgPcrHtml distinguishes one primary plus one alt hit', async () => {
  const html = await readFile(path.join(here, 'fixtures', 'hgpcr-multiple.html'), 'utf8');
  const result = parseHgPcrHtml(html);
  assert.equal(result.status, 'ok');
  assert.equal(result.classification, 'review_patch_or_alt');
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].productSize, 180);
  assert.equal(result.products[1].contigClass, 'alt');
});

test('parseHgPcrHtml keeps no-product distinct from parse failure', () => {
  assert.equal(parseHgPcrHtml('<p>No matches to AAA BBB in Human.</p>').classification, 'no_product');
  assert.equal(parseHgPcrHtml('<html><body>unexpected</body></html>').classification, 'parse_error');
});

test('unknown contigs are not silently classified as primary products', () => {
  const product = { contigClass: classifyContig('chrEBV') };
  assert.equal(product.contigClass, 'other');
  assert.equal(classifyProducts([product]), 'review_non_primary_only');
});
