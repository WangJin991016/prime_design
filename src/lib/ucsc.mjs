const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function buildHgPcrUrl(candidate, ucscConfig) {
  const base = new URL('/cgi-bin/hgPcr', ucscConfig.baseUrl);
  const params = base.searchParams;
  params.set('db', ucscConfig.assembly);
  params.set('wp_target', ucscConfig.target || 'genome');
  params.set('wp_f', candidate.forwardSequence);
  params.set('wp_r', candidate.reverseSequence);
  params.set('wp_size', String(ucscConfig.maxProductSize));
  params.set('wp_perfect', String(ucscConfig.minPerfect));
  params.set('wp_good', String(ucscConfig.minGood));
  params.set('wp_append', '0');
  if (ucscConfig.flipReverse) params.set('wp_flipReverse', '1');
  return base.toString();
}

export function buildBlatSubmission(candidate, ucscConfig) {
  const fasta = [
    `>${candidate.candidateId}_forward`,
    candidate.forwardSequence,
    `>${candidate.candidateId}_reverse`,
    candidate.reverseSequence,
  ].join('\n');
  return {
    action: new URL('/cgi-bin/hgBlat', ucscConfig.baseUrl).toString(),
    method: 'post',
    fields: {
      db: ucscConfig.assembly,
      type: 'DNA',
      output: 'hyperlink',
      userSeq: fasta,
    },
  };
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
      if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return HTML_ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
    });
}

export function classifyContig(contig) {
  if (/_alt$/i.test(contig)) return 'alt';
  if (/_fix$/i.test(contig)) return 'fix';
  if (/_random$/i.test(contig)) return 'random';
  if (/^chrUn/i.test(contig)) return 'unplaced';
  if (/^chr(?:[0-9]+|X|Y|M|MT)$/i.test(contig)) return 'primary';
  return 'other';
}

export function classifyProducts(products) {
  if (!products.length) return 'no_product';
  const primary = products.filter((product) => product.contigClass === 'primary');
  if (primary.length === 1 && products.length === 1) return 'pass_single_product';
  if (primary.length === 1 && products.length > 1) return 'review_patch_or_alt';
  if (primary.length > 1) return 'fail_multiple_loci';
  return 'review_non_primary_only';
}

export function parseHgPcrHtml(html) {
  const source = String(html);
  if (/bot.{0,30}(warning|check|delay)|too many requests|access denied/i.test(source)) {
    return { status: 'service_error', classification: 'service_error', products: [], warnings: ['UCSC 返回访问限制或 bot 检查页面。'] };
  }
  if (/No matches to/i.test(source)) {
    return { status: 'ok', classification: 'no_product', products: [], warnings: [] };
  }

  const preBlocks = [...source.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((match) => decodeHtml(match[1]));
  const text = preBlocks.join('\n');
  const pattern = /^>([^\s:>]+):(\d+)([+-])(\d+)\s+([ACGTRYSWKMBDHVN]+)\s+([ACGTRYSWKMBDHVN]+)/gim;
  const products = [];
  for (const match of text.matchAll(pattern)) {
    const start1 = Number(match[2]);
    const end1 = Number(match[4]);
    const contig = match[1];
    products.push({
      contig,
      contigClass: classifyContig(contig),
      start1,
      end1,
      strand: match[3],
      productSize: Math.abs(end1 - start1) + 1,
      forwardSequence: match[5].toUpperCase(),
      reverseSequence: match[6].toUpperCase(),
      rawHeader: match[0].slice(1),
    });
  }

  if (!products.length) {
    return {
      status: 'parse_error',
      classification: 'parse_error',
      products: [],
      warnings: ['页面不是可识别的 UCSC hgPcr 结果；不要把解析失败当成无产物。'],
    };
  }
  return { status: 'ok', classification: classifyProducts(products), products, warnings: [] };
}
