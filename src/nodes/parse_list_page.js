/* Parse List Page — Stage 1 of the two-stage filter.
 * Reads the price straight off the results page and keeps ONLY the listings
 * above the threshold, so detail pages are never fetched for the ~97% of
 * stock priced below it. */
const store = $getWorkflowStaticData('global');
const s = store.zida;
const item = $input.first().json;

function emit(extra) {
  return [{ json: Object.assign({
    page: s.page,
    pages_fetched: s.pages_fetched,
    scanned: s.scanned,
    qualifying_so_far: s.qualifying.length,
    category: s.category,
    next_url: s.next_url_out || s.base_url,
    sb_url: scrapingBeeUrl(s.next_url_out || s.base_url, s.sb),
    done: false,
    blocked: false
  }, extra) }];
}

// The HTTP node is set to continue on failure, so a request that failed all
// 3 retries arrives here as an error item rather than aborting the run.
if (isFetchError(item)) {
  s.list_fetch_errors++;
  s.stop_reason = 'list_fetch_failed_page_' + s.page + ': ' + describeFetchError(item);
  return emit({ done: true, stop_reason: s.stop_reason });
}

const html = String(item.body !== undefined ? item.body : (item.data !== undefined ? item.data : ''));
const status = Number(item.statusCode || 200);

const block = detectBlock(html, status);
if (block.blocked) {
  s.stop_reason = 'blocked:' + block.reason;
  return emit({ done: true, blocked: true, block_reason: block.reason, block_detail: block.detail });
}

s.pages_fetched++;

// Learn the real pagination pattern from the page itself instead of guessing.
if (!s.page_template) {
  const det = detectPaginationTemplate(html, s.base_url);
  if (det) { s.page_template = det.template; s.pagination_style = det.style + ' (via ' + det.via + ')'; }
  else { s.pagination_style = 'NOT DETECTED — using fallback ?strana=N'; }
}

// Calibration fetch: page 1 was only needed for the template, jump to the resume point.
if (!s.calibrated) {
  s.calibrated = true;
  if (s.resume_from_page > 1) {
    s.page = s.resume_from_page;
    s.next_url_out = buildPageUrl(s.page_template, s.base_url, s.page);
    return emit({ done: false, note: 'calibrated, resuming at page ' + s.page,
                  next_url: s.next_url_out, sb_url: scrapingBeeUrl(s.next_url_out, s.sb) });
  }
}

const parsed = parseListPage(html);
const ids = parsed.listings.map(l => l.listing_id);
s.strategies_used[parsed.diagnostics.best_strategy] = (s.strategies_used[parsed.diagnostics.best_strategy] || 0) + 1;

// End of results: nothing on the page, or the site clamped us back to a page
// we have already seen (both observed shapes of "past the last page").
const repeated = ids.length > 0 && s.prev_ids.length === ids.length && ids.every(id => s.prev_ids.indexOf(id) !== -1);
if (ids.length === 0) { s.stop_reason = 'end_of_results:empty_page_' + s.page; return emit({ done: true, stop_reason: s.stop_reason, listings_on_page: 0 }); }
if (repeated) { s.stop_reason = 'end_of_results:page_repeated_at_' + s.page; return emit({ done: true, stop_reason: s.stop_reason }); }
s.prev_ids = ids;

let kept = 0;
for (const l of parsed.listings) {
  s.scanned++;
  if (l.price == null) { s.unpriced++; continue; }          // "Cena na upit" — skipped, not an error
  if (l.price <= s.min_price_eur) { s.below_threshold++; continue; }
  s.qualifying.push({ listing_id: l.listing_id, url: l.url, list_price: l.price, price_source: l.price_source });
  kept++;
}

s.last_completed_page = s.page;
if (s.max_pages && s.pages_fetched >= s.max_pages) {
  s.stop_reason = 'max_pages_reached_' + s.max_pages;
  return emit({ done: true, stop_reason: s.stop_reason, kept_on_page: kept });
}
if (s.page >= 5000) { s.stop_reason = 'hard_page_cap_5000'; return emit({ done: true, stop_reason: s.stop_reason }); }

s.last_completed_page = s.page;
s.page++;
s.next_url_out = buildPageUrl(s.page_template, s.base_url, s.page);
return emit({
  done: false,
  next_url: s.next_url_out,
  sb_url: scrapingBeeUrl(s.next_url_out, s.sb),
  listings_on_page: parsed.diagnostics.links_found,
  priced_on_page: parsed.diagnostics.priced,
  kept_on_page: kept,
  strategy: parsed.diagnostics.best_strategy
});
