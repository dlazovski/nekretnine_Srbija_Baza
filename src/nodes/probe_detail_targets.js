/* Build Detail Probe Targets — the first real listing found in each category,
 * so the detail-page selectors are spot-checked per category, not only on a flat. */
const store = $getWorkflowStaticData('global');
const out = [];
for (const k of Object.keys(store.probe.list)) {
  const rec = store.probe.list[k];
  if (rec.kind !== 'list') continue;
  const first = (rec.sample_listings || [])[0];
  if (first && first.url) out.push({ json: { _none: false, slug: rec.slug, url: first.url,
    sb_url: scrapingBeeUrl(first.url, store.probe.sb), listing_id: first.id, list_price: first.price } });
}
if (!out.length) return [{ json: { _none: true } }];
return out;
