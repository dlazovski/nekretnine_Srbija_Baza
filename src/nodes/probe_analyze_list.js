/* Analyze List Probe — records, per category, everything Step 0 must confirm:
 * the pagination mechanism, which price strategy fires, and how a blocked
 * response differs from an ordinary parse miss. */
const store = $getWorkflowStaticData('global');
const t = $('Loop Probe A').first().json;
const item = $input.first().json;

const rec = { slug: t.slug, kind: t.kind, url: t.url };

if (isFetchError(item)) {
  rec.fetch_error = describeFetchError(item);
  store.probe.list[t.kind + ':' + t.slug] = rec;
  return [{ json: rec }];
}

const html = String(item.body !== undefined ? item.body : (item.data !== undefined ? item.data : ''));
rec.http_status = Number(item.statusCode || 0);
rec.bytes = html.length;

const block = detectBlock(html, rec.http_status);
rec.blocked = block.blocked;
rec.block_reason = block.reason;
rec.block_detail = block.detail;

rec.has_jsonld = /application\/ld\+json/i.test(html);
rec.has_nuxt_payload = /__NUXT__|__NUXT_DATA__|__NEXT_DATA__/.test(html);
rec.title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim().slice(0, 160);

const parsed = parseListPage(html);
rec.links_found = parsed.diagnostics.links_found;
rec.best_price_strategy = parsed.diagnostics.best_strategy;
rec.price_strategy_coverage = parsed.diagnostics.coverage;
rec.priced = parsed.diagnostics.priced;
rec.unpriced = parsed.diagnostics.unpriced;
rec.price_coverage_pct = rec.links_found ? Math.round(100 * rec.priced / rec.links_found) : 0;
rec.sample_listings = parsed.listings.slice(0, 3).map(l => ({
  id: l.listing_id, url: l.url, price: l.price, price_source: l.price_source, on_request: l.price_on_request
}));

const pg = detectPaginationTemplate(html, 'https://www.4zida.rs/' + t.slug);
rec.pagination_detected = !!pg;
rec.pagination_style = pg ? pg.style : 'NONE FOUND — workflow would fall back to ?strana=N';
rec.pagination_template = pg ? pg.template : buildPageUrl(null, 'https://www.4zida.rs/' + t.slug, 2);

if (t.kind === 'list_far') {
  rec.end_of_results_signature = {
    http_status: rec.http_status,
    listings_found: rec.links_found,
    bytes: rec.bytes,
    looks_empty: rec.links_found === 0,
    note: rec.links_found > 0
      ? 'Out-of-range page still returned listings — the site probably clamps to the last page; the workflow detects that via repeated ids.'
      : 'Out-of-range page returned no listings — the workflow stops on empty_page.'
  };
}

store.probe.list[t.kind + ':' + t.slug] = rec;
return [{ json: rec }];
