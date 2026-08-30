/* Build Detail Probe Targets — the first real listing found in each category,
 * so the detail-page selectors are spot-checked per category, not only on a flat. */
const store = $getWorkflowStaticData('global');
const out = [];
for (const k of Object.keys(store.probe.list)) {
  const rec = store.probe.list[k];
  if (rec.kind !== 'list') continue;
  // Probe the first TWO listings. A mis-attributed price gets the FIRST
  // listing right by accident, so probing only that one proves nothing.
  (rec.sample_listings || []).slice(0, 2).forEach((l, i) => {
    if (!l || !l.url) return;
    out.push({ json: { _none: false, slug: rec.slug, rank: i, url: l.url,
      sb_url: scrapingBeeUrl(l.url, store.probe.sb), listing_id: l.id, list_price: l.price } });
  });
}
if (!out.length) return [{ json: { _none: true } }];
return out;
