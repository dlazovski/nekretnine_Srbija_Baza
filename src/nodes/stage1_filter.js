/* Stage 1 Filter & Dedupe — authoritative re-application of the price rule,
 * plus de-duplication by listing id (the 24-hex final path segment).
 * One item out per listing whose detail page is worth spending a request on. */
const store = $getWorkflowStaticData('global');
const s = store.zida;

const seen = Object.create(null);
const out = [];
for (const q of s.qualifying) {
  if (!q.listing_id || seen[q.listing_id]) continue;
  if (!(Number(q.list_price) > s.min_price_eur)) continue;   // authoritative threshold
  seen[q.listing_id] = true;
  out.push(q);
}

// Resume support: drop everything up to and including the last listing that
// was confirmed written to the sheet on the previous, interrupted run.
if (s.resume_after_listing_id) {
  const at = out.findIndex(o => o.listing_id === s.resume_after_listing_id);
  if (at !== -1) { s.resume_skipped = at + 1; out.splice(0, at + 1); }
  else { s.resume_skipped = 0; s.resume_warning = 'resume_after_listing_id not found in this run’s queue — nothing skipped'; }
}

s.dedup_total = out.length;
s.duplicates_dropped = s.qualifying.length - Object.keys(seen).length;

if (out.length === 0) {
  // Keep one item flowing so the summary branch still runs.
  return [{ json: { _no_listings: true, category: s.category } }];
}
return out.map(o => ({ json: {
  _no_listings: false,
  listing_id: o.listing_id,
  url: o.url,
  sb_url: scrapingBeeUrl(o.url, s.sb),
  list_price: o.list_price,
  list_price_source: o.price_source,
  category: s.category
} }));
