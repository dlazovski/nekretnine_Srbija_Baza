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

if (!d.advertiser_name && !d.phone) {
  // No advertiser block at all: almost always means the link is not an ad page
  // (a search/listing URL that slipped through), so the row belongs in Errors
  // where it is visible, not in Results as a price with no contact.
  s.detail_no_advertiser = (s.detail_no_advertiser || 0) + 1;
  return [{ json: Object.assign({}, base, {
    status: 'error', blocked: false,
    error_message: 'no advertiser block on the page (no name and no phone) — the link is probably not a listing page. ' +
      'Page bytes: ' + html.length + '; author block present: ' + /authorData|"phones"/.test(html)
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
