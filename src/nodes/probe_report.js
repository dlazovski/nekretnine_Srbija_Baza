/* Build Step 0 Report — the findings to read BEFORE running the scraper.
 * Every "action" line names something to fix in src/lib/parse.js. */
const store = $getWorkflowStaticData('global');
const list = store.probe.list, detail = store.probe.detail;
const actions = [];

let failedRequests = 0;
const perCategory = Object.keys(list).filter(k => list[k].kind === 'list').map(k => {
  const r = list[k], d = detail[r.slug] || {};
  if (r.fetch_error) {
    // Nothing below can be concluded from a request that never returned a page.
    failedRequests++;
    actions.push('[' + r.slug + '] REQUEST FAILED, no page was retrieved: ' + r.fetch_error +
      ' >> Everything else reported for this category is meaningless until this is fixed. ' +
      'Check the ScrapingBee credential (Query Auth, name must be exactly "api_key"), your remaining credits, ' +
      'and the Probe Config premium_proxy/country_code pair (country_code is only valid with premium_proxy=true).');
    return { category: r.slug, REQUEST_FAILED: r.fetch_error, requested_url: r.url, detail_probe: {} };
  }
  if (r.blocked) actions.push('[' + r.slug + '] LIST PAGE BLOCKED (' + r.block_reason + ') — fix ScrapingBee options (premium_proxy / country_code=rs) before running.');
  if (!r.blocked && r.links_found === 0) actions.push('[' + r.slug + '] No listing links matched. LISTING_PATH_RE in src/lib/parse.js needs updating for this category.');
  if (r.links_found > 0 && r.price_coverage_pct < 90) actions.push('[' + r.slug + '] Only ' + r.price_coverage_pct + '% of listings had a parseable price — check findPriceCandidates()/card slicing before trusting Stage 1.');
  if (!r.pagination_detected) actions.push('[' + r.slug + '] Pagination pattern NOT detected — the workflow will fall back to ?strana=N. Confirm that is right or set it in buildPageUrl().');
  if (d.fetch_error) actions.push('[' + r.slug + '] Detail-page request FAILED: ' + d.fetch_error);
  if (d.render_js_needed_for_phone) actions.push('[' + r.slug + '] Phone appears MASKED ONLY in raw HTML — the no-render_js assumption fails for this category.');
  if (d.phone_source === 'raw-html') actions.push('[' + r.slug + '] Phone came from the loose raw-HTML regex, not a phone-specific key. Check phone_context and add the site’s own number to Config.exclude_phones if it was picked up.');
  if (!d.advertiser_name) actions.push('[' + r.slug + '] Advertiser name not found — extend NAME_KEYS in src/lib/parse.js.');
  if (d.advertiser_source === 'dom-near-phone') actions.push('[' + r.slug + '] Advertiser name came from the weakest DOM fallback — verify it against the live page.');
  return {
    category: r.slug,
    list_http: r.http_status, list_bytes: r.bytes, blocked: r.blocked,
    listings_on_page_1: r.links_found,
    price_coverage_pct: r.price_coverage_pct,
    best_price_strategy: r.best_price_strategy,
    price_strategy_coverage: r.price_strategy_coverage,
    pagination_style: r.pagination_style,
    pagination_template: r.pagination_template,
    has_jsonld: r.has_jsonld, has_hydration_payload: r.has_nuxt_payload,
    sample_listings: r.sample_listings,
    detail_probe: {
      url: d.url, http: d.http_status, blocked: d.blocked,
      advertiser_name: d.advertiser_name, advertiser_source: d.advertiser_source,
      price_eur: d.price_eur, price_source: d.price_source,
      phone: d.phone, phone_source: d.phone_source, phone_raw: d.phone_raw,
      phone_masked_form_on_page: d.masked_form_present,
      phone_available_without_render_js: d.phone_present_unmasked,
      phone_context: d.phone_context,
      looks_like_agency_listing: d.listing_looks_like_agency,
      other_phone_candidates: d.phone_candidates,
      other_name_candidates: d.advertiser_candidates,
      warnings: d.warnings
    }
  };
});

const far = list['list_far:' + (perCategory[0] || {}).category] ||
            list[Object.keys(list).find(k => k.indexOf('list_far:') === 0)];

const detailFailed = Object.keys(detail).filter(k => detail[k].fetch_error).length;
const totalRecords = Object.keys(list).length + Object.keys(detail).length;
const totalFailed = failedRequests + detailFailed +
  Object.keys(list).filter(k => list[k].kind !== 'list' && list[k].fetch_error).length;

return [{ json: {
  STEP_0_REPORT: totalFailed === totalRecords
    ? 'EVERY REQUEST FAILED - this report contains no evidence about the site. Fix the failure in actions_required and re-run.'
    : (totalFailed ? totalFailed + ' of ' + totalRecords + ' requests failed; treat those categories as unprobed.'
                   : 'Read the actions_required list first. Everything else is evidence.'),
  probed_at: store.probe.started_at,
  requests_attempted: totalRecords,
  requests_failed: totalFailed,
  scrapingbee_requests_used: totalRecords - totalFailed,
  actions_required: actions.length ? actions : ['None — all Step 0 assumptions held on the pages probed.'],
  end_of_results_behaviour: far ? far.end_of_results_signature : 'not probed',
  block_detection_note: 'A blocked response is reported as blocked:true with a reason (challenge_page / http_403 / http_429 / scrapingbee_error / suspicious_stub). Anything else with 0 listings is a PARSE failure, not a block.',
  per_category: perCategory
} }];
