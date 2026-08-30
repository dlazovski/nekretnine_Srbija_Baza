/* Extract 4 Fields — Stage 2. Pulls exactly the four deliverable fields from
 * a detail page. A missing field is left blank; only a hard failure (bad
 * fetch, or a block) is routed away from the Results tab. */
const store = $getWorkflowStaticData('global');
const s = store.zida;
const src = $('Loop Over Listings').first().json;
const item = $input.first().json;

const link = src.url;
const base = {
  listing_id: src.listing_id,
  link: link,
  category: s.category,
  list_price: src.list_price
};

if (isFetchError(item)) {
  return [{ json: Object.assign({}, base, {
    status: 'error', blocked: false,
    error_message: 'fetch failed after retries: ' + describeFetchError(item)
  }) }];
}

const html = String(item.body !== undefined ? item.body : (item.data !== undefined ? item.data : ''));
const status = Number(item.statusCode || 200);

const block = detectBlock(html, status);
if (block.blocked) {
  return [{ json: Object.assign({}, base, {
    status: 'blocked', blocked: true,
    block_reason: block.reason, block_detail: block.detail,
    error_message: 'BLOCKED (' + block.reason + '): ' + block.detail
  }) }];
}

const d = parseDetail(html, link, { exclude_phones: s.exclude_phones });

// Sanity check against the Stage 1 price. A mismatch does not fail the row —
// the detail-page price wins and the discrepancy is recorded for spot-checks.
let priceMismatch = '';
if (d.price_eur !== '' && Number(src.list_price) !== Number(d.price_eur)) {
  priceMismatch = 'list=' + src.list_price + ' detail=' + d.price_eur;
}
const finalPrice = d.price_eur !== '' ? d.price_eur : src.list_price;

// Classify what we actually got. A real listing page is ~1 MB and carries both
// JSON-LD and the Next.js flight payload. Two very different failures look
// alike from the outside and need opposite responses:
//   - ad_removed  : the ad is gone. Nothing to recover, skip it.
//   - thin_shell  : the page came back WITHOUT server-rendered content, which
//                   is how a site soft-blocks a scraper. That is lost real
//                   data, not a dead ad, and it must not be silently dropped.
const pageInfo = {
  bytes: html.length,
  has_jsonld: /application\/ld\+json/i.test(html),
  has_payload: /self\.__next_f|__NEXT_DATA__|__NUXT__/.test(html),
  has_author_block: /authorData|"phones"/.test(html),
  says_removed: /nije\s*dostupan|nije\s*vi[sš]e|uklonjen|ne\s*postoji|arhiviran|istekao/i.test(html),
  title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim().slice(0, 120)
};
pageInfo.kind = (!pageInfo.has_payload && !pageInfo.has_jsonld) ? 'thin_shell'
  : (pageInfo.says_removed ? 'ad_removed' : 'no_advertiser_block');

if (pageInfo.kind === 'thin_shell') {
  s.detail_thin_shell = (s.detail_thin_shell || 0) + 1;
  s.thin_shell_bytes = s.thin_shell_bytes || [];
  if (s.thin_shell_bytes.length < 8) s.thin_shell_bytes.push(html.length);
}

// A site that soft-blocks returns thin pages at a steady rate. Once enough
// listings have been processed to judge, stop rather than burn thousands of
// credits collecting shells. This is the "blocked vs parse failure" distinction
// the brief asked for, applied to a block that carries no challenge markers.
const processed = (s.detail_written || 0) + (s.detail_errors || 0) + 1;
const thinRate = (s.detail_thin_shell || 0) / processed;
if (processed >= 20 && thinRate >= 0.4) {
  return [{ json: Object.assign({}, base, {
    status: 'blocked', blocked: true,
    block_reason: 'soft_block_thin_pages',
    block_detail: Math.round(thinRate * 100) + '% of ' + processed + ' pages came back without server-rendered ' +
      'content (~' + Math.round(html.length / 1024) + ' KB instead of ~1 MB). That is a soft block, not missing ads. ' +
      'Try premium_proxy=true, a longer delay_seconds, or render_js=true on Fetch Detail Page, then resume.',
    error_message: 'BLOCKED (soft): thin pages at ' + Math.round(thinRate * 100) + '%'
  }) }];
}

// Identity check first: is this even the page we asked for? A removed or
// expired ad is redirected by 4zida to a search page, and scraping THAT yields
// a real phone belonging to somebody else's listing — worse than a blank row.
if (!d.page_references_listing) {
  s.detail_wrong_page = (s.detail_wrong_page || 0) + 1;
  return [{ json: Object.assign({}, base, {
    status: 'error', blocked: false,
    error_message: pageInfo.kind + ': page does not reference listing id ' + src.listing_id +
      '. bytes=' + pageInfo.bytes + ' jsonld=' + pageInfo.has_jsonld + ' payload=' + pageInfo.has_payload +
      ' author_block=' + pageInfo.has_author_block + ' says_removed=' + pageInfo.says_removed +
      ' title="' + pageInfo.title + '"'
  }) }];
}

// The advertiser name is one of the four deliverable fields and comes from the
// same block as the phone; a page missing it is not a normal ad page.
if (!d.advertiser_name) {
  s.detail_no_advertiser = (s.detail_no_advertiser || 0) + 1;
  return [{ json: Object.assign({}, base, {
    status: 'error', blocked: false,
    error_message: pageInfo.kind + ': no advertiser name (phone found: ' + (d.phone ? 'yes' : 'no') +
      '). bytes=' + pageInfo.bytes + ' jsonld=' + pageInfo.has_jsonld + ' payload=' + pageInfo.has_payload +
      ' title="' + pageInfo.title + '"'
  }) }];
}
if (!d.advertiser_name || !d.phone || finalPrice === '') s.detail_blank_fields++;

return [{ json: Object.assign({}, base, {
  status: 'ok',
  blocked: false,
  advertiser_name: d.advertiser_name,
  price_eur: finalPrice,
  phone: d.phone,
  price_source: d.price_source,
  phone_source: d.phone_source,
  advertiser_source: d.advertiser_source,
  price_mismatch: priceMismatch,
  warnings: (d.warnings || []).join('|'),
  error_message: ''
}) }];
