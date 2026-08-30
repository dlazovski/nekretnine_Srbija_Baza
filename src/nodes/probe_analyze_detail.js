/* Analyze Detail Probe — the Step 0 question that matters most: where exactly
 * does the unmasked phone sit in the raw HTML, and is the advertiser name in
 * the same place for agency listings as for private ones? */
const store = $getWorkflowStaticData('global');
const t = $('Loop Probe B').first().json;
const item = $input.first().json;
const rec = { slug: t.slug, url: t.url, list_price: t.list_price };

if (isFetchError(item)) {
  rec.fetch_error = describeFetchError(item);
  store.probe.detail[t.slug] = rec;
  return [{ json: rec }];
}

const html = String(item.body !== undefined ? item.body : (item.data !== undefined ? item.data : ''));
rec.http_status = Number(item.statusCode || 0);
rec.bytes = html.length;

const block = detectBlock(html, rec.http_status);
rec.blocked = block.blocked;
rec.block_reason = block.reason;

const d = parseDetail(html, t.url, { exclude_phones: String(($('Probe Config').first().json.exclude_phones) || '').split(',').map(s => s.trim()).filter(Boolean) });
rec.advertiser_name = d.advertiser_name;
rec.advertiser_source = d.advertiser_source;
rec.advertiser_candidates = d.all_advertisers;
rec.price_eur = d.price_eur;
rec.price_source = d.price_source;
rec.phone = d.phone;
rec.phone_source = d.phone_source;
rec.phone_raw = d.phone_raw;
rec.phone_candidates = d.all_phones;
rec.warnings = d.warnings;

// Is the unmasked number really in the raw HTML, or only the masked display form?
rec.masked_form_present = /\*{2,}/.test(html);
rec.phone_present_unmasked = !!d.phone;
rec.render_js_needed_for_phone = rec.masked_form_present && !d.phone;

// Which container the winning phone sits in — the fact the deliverable notes need.
if (d.phone_raw) {
  const at = html.indexOf(d.phone_raw);
  rec.phone_context = at === -1 ? '' : html.slice(Math.max(0, at - 220), at + 120).replace(/\s+/g, ' ');
}
rec.listing_looks_like_agency = /agencij|agency|"agencyId"|RealEstateAgent|investitor/i.test(html);

store.probe.detail[t.slug] = rec;
return [{ json: rec }];
