/* Build Probe Targets — the Step 0 request plan.
 * One page-1 request per category (structure + pagination + price selectors)
 * plus one deliberately out-of-range page (what "past the last page" looks like). */
const cfg = $('Probe Config').first().json;
const store = $getWorkflowStaticData('global');
store.probe = { list: {}, detail: {}, started_at: new Date().toISOString() };

const sb = { premium_proxy: cfg.premium_proxy, country_code: cfg.country_code, render_js: false };
store.probe.sb = sb;

const cats = String(cfg.categories || '').split(',').map(s => s.trim()).filter(Boolean);
const targets = cats.map(slug => ({
  kind: 'list',
  slug: slug,
  url: 'https://www.4zida.rs/' + slug
}));
if (targets.length) {
  targets.push({ kind: 'list_far', slug: cats[0], url: 'https://www.4zida.rs/' + cats[0] + '?strana=' + (cfg.far_page || 9999) });
}
return targets.map(t => ({ json: Object.assign(t, { sb_url: scrapingBeeUrl(t.url, sb) }) }));
