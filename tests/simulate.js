/* End-to-end simulation of the BUILT workflow: runs the exact jsCode shipped
 * inside workflows/4zida-serbia-scraper.json against fixture pages, with the
 * n8n runtime globals mocked. Catches wiring/runtime bugs that a unit test on
 * the library alone would miss. */
const fs = require('fs'), vm = require('vm'), path = require('path');

const WF = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows/4zida-serbia-scraper.json'), 'utf8'));
const CODE = Object.fromEntries(WF.nodes.filter(n => n.type === 'n8n-nodes-base.code')
  .map(n => [n.name, n.parameters.jsCode]));
const CONFIG_NODE = WF.nodes.find(n => n.name === 'Config');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')); } };
const eq = (n, g, w) => ok(n + '  (got ' + JSON.stringify(g) + ')', JSON.stringify(g) === JSON.stringify(w));

/* ---------------------------------------------------------- fixtures ---- */
const id = n => n.toString(16).padStart(24, '0');
const PRICES = {};                       // listing id -> price
function listPage(pageNo, count, opts) {
  opts = opts || {};
  let h = '<html><head><title>Stanovi</title>';
  if (pageNo < 3) h += '<link rel="next" href="https://www.4zida.rs/prodaja-stanova?strana=' + (pageNo + 1) + '">';
  h += '</head><body><header><a href="tel:0113334444">4zida podrska</a></header><main>';
  for (let i = 0; i < count; i++) {
    const n = pageNo * 100 + i, lid = id(n);
    const price = opts.repeatOf ? PRICES[lid] : (i % 3 === 0 ? 250000 + n : (i % 3 === 1 ? 85000 : null));
    PRICES[lid] = price;
    const href = '/prodaja-stanova/vracar-beograd/trosoban-stan/' + lid;
    h += '<article><a href="' + href + '"><img src="/_nuxt/aabbccddeeff00112233445566.jpg"></a>' +
         '<a href="' + href + '">Stan ' + n + '</a>' +
         (price === null ? '<p>Cena na upit</p>' : '<p>' + price.toLocaleString('de-DE') + ' €</p>') +
         '<p>2.900 €/m²</p></article>';
  }
  return h + '</main><footer>4zida.rs</footer></body></html>';
}
const CHROME = '<html lang="sr"><head><title>4zida.rs</title></head>';
const BULK = '<div class="pad">' + 'sadr\u017eaj '.repeat(400) + '</div>';
function detailPage(lid, kind) {
  const price = PRICES[lid];
  if (kind === 'agency') {
    return CHROME + BULK + '<body><h1>Stan</h1><div>' + price.toLocaleString('de-DE') + ' €</div>' +
      '<script type="application/ld+json">{"@type":"Offer","price":' + price + ',"priceCurrency":"EUR",' +
      '"seller":{"@type":"RealEstateAgent","name":"Alfa Nekretnine DOO"}}</script>' +
      '<span itemprop="telephone" content="0631112223"></span></body></html>';
  }
  if (kind === 'nophone') {
    return CHROME + BULK + '<body><h1>Stan</h1><div>' + price.toLocaleString('de-DE') + ' €</div>' +
      '<script>window.__NUXT__={ad:{"advertiserName":"Ana Jovanović"}}</script></body></html>';
  }
  return CHROME + BULK + '<head><script type="application/ld+json">{"@type":"Product","offers":{"price":"' + price +
    '","priceCurrency":"EUR"}}</script></head><body><header><a href="tel:0113334444">podrska</a></header>' +
    '<span>062 43****</span><button>Prikaži</button>' +
    '<script>window.__NUXT__={ad:{"id":"' + lid + '","advertiserName":"Milan Petrović","phone":"+381 62 4312345"}}</script>' +
    '</body></html>';
}

/* --------------------------------------------------------- n8n mocks ---- */
function runNode(name, inputItems, out, store) {
  const ctx = {
    console: { log: () => {} }, JSON, Math, Number, String, Boolean, Object, Array, Date, RegExp, parseInt, parseFloat, isFinite, Error,
    $getWorkflowStaticData: () => store,
    $input: { first: () => inputItems[0], all: () => inputItems, last: () => inputItems[inputItems.length - 1] },
    $json: inputItems[0] ? inputItems[0].json : {},
    $: (n) => {
      if (!out[n]) throw new Error("simulated $('" + n + "') has no output yet");
      return { first: () => out[n][0], all: () => out[n], last: () => out[n][out[n].length - 1] };
    }
  };
  const fn = vm.runInNewContext('(function(){\n' + CODE[name] + '\n})', ctx);
  const r = fn();
  out[name] = r;
  return r;
}
function configItems(overrides) {
  const j = {};
  for (const a of CONFIG_NODE.parameters.assignments.assignments) j[a.name] = a.value;
  return [{ json: Object.assign(j, overrides || {}) }];
}
const httpItem = (body, status) => [{ json: { body: body, statusCode: status === undefined ? 200 : status, headers: {} } }];

/* ------------------------------------------------- run the whole thing -- */
function runWorkflow(cfgOverrides, pageFor, detailKindFor) {
  const store = {}, out = {};
  out['Config'] = configItems(cfgOverrides);
  runNode('Init Pager', out['Config'], out, store);

  const fetched = [], pageCheckpoints = [];
  let cur = out['Init Pager'][0], guard = 0;
  while (guard++ < 40) {
    fetched.push(cur.json.next_url);
    const resp = pageFor(cur.json.next_url);
    const parsed = runNode('Parse List Page', httpItem(resp.body, resp.status), out, store)[0];
    if (parsed.json.blocked) return { store, out, fetched, blocked: parsed.json };
    if (parsed.json.done) break;
    // the pagination-phase checkpoint fires on the loop-back path
    pageCheckpoints.push(runNode('Build Page Checkpoint Row', [parsed], out, store)[0].json);
    cur = parsed;
  }

  const stage1 = runNode('Stage 1 Filter and Dedupe', [out['Parse List Page'][0]], out, store);
  const results = [], errors = [];
  if (!stage1[0].json._no_listings) {
    for (const litem of stage1) {
      out['Loop Over Listings'] = [litem];
      const lid = litem.json.listing_id;
      const kind = detailKindFor ? detailKindFor(lid) : 'private';
      const resp = kind === 'fetcherror'
        ? [{ json: { error: { message: 'ECONNRESET' } } }]
        : kind === 'searchpage'
          ? httpItem(CHROME + BULK + '<body><h1>Pretraga rezultati</h1><div>250.000 €</div></body></html>', 200)
          : httpItem(detailPage(lid, kind), 200);
      const ex = runNode('Extract 4 Fields', resp, out, store)[0];
      if (ex.json.blocked) return { store, out, fetched, detailBlocked: ex.json };
      if (ex.json.status === 'ok') {
        runNode('Count Written', [ex], out, store);
        results.push(ex.json);
        if (store.zida.detail_written % out['Config'][0].json.checkpoint_every === 0) {
          runNode('Build Checkpoint Row', [ex], out, store);
        }
      } else {
        runNode('Count Error', [ex], out, store);
        errors.push(ex.json);
      }
    }
  }
  const summary = runNode('Build Summary', [{ json: {} }], out, store)[0].json;
  return { store, out, fetched, pageCheckpoints, results, errors, summary };
}

const pages = { 1: null, 2: null, 3: null };
const serve = (url) => {
  const m = url.match(/strana=(\d+)/);
  const p = m ? Number(m[1]) : 1;
  if (p >= 4) return { body: listPage(p, 0), status: 200 };
  return { body: (pages[p] = pages[p] || listPage(p, 12)), status: 200 };
};

/* ---- happy path ---- */
const r = runWorkflow({}, serve);
eq('paged through 4 pages then stopped', r.fetched.length, 4);
ok('used the detected ?strana= template', r.fetched[1] === 'https://www.4zida.rs/prodaja-stanova?strana=2', r.fetched);
eq('pagination style detected', r.store.zida.pagination_style, 'query:strana (via rel=next)');
eq('stage1 scanned every listing', r.summary.stage1_listings_scanned, 36);
eq('stage1 skipped price-on-request', r.summary.stage1_skipped_no_price, 12);
eq('stage1 dropped sub-100k', r.summary.stage1_below_threshold, 12);
eq('stage1 kept the expensive ones', r.summary.stage1_passed_price_filter, 12);
eq('detail pages queued == qualifiers', r.summary.detail_pages_queued, 12);
eq('all written', r.summary.written_to_sheet, 12);
eq('no errors', r.summary.errors_logged, 0);
eq('nothing unaccounted for', r.summary.unaccounted, 0);
eq('stop reason', r.summary.stop_reason, 'end_of_results:empty_page_4');
ok('every result has all 4 fields', r.results.every(x => x.advertiser_name && x.price_eur && x.phone && x.link), r.results[0]);
eq('sample row', [r.results[0].advertiser_name, r.results[0].phone, r.results[0].price_eur],
   ['Milan Petrović', '0624312345', 250100]);
ok('never fetched a sub-100k detail page', r.results.every(x => x.price_eur > 100000));
ok('site support number never used as advertiser phone', r.results.every(x => x.phone !== '0113334444'));
eq('category label', r.results[0].category, 'Stanovi (apartments)');

/* a run interrupted during pagination must still have somewhere to resume from */
ok('checkpoints are written during the pagination phase', r.pageCheckpoints.length > 0, r.pageCheckpoints.length);
eq('pagination checkpoint is labelled PAGING', r.pageCheckpoints[0].status, 'PAGING');
eq('pagination checkpoint records the completed page', r.pageCheckpoints[0].last_page, 1);
ok('pagination checkpoint carries the category', r.pageCheckpoints[0].category === 'Stanovi (apartments)');
ok('detail-phase checkpoint switches to IN_PROGRESS',
   runNode('Build Checkpoint Row', [{ json: {} }], r.out, r.store)[0].json.status === 'IN_PROGRESS');

/* ---- mixed advertisers, missing fields, fetch errors ---- */
const kinds = {};
const r2 = runWorkflow({}, serve, (lid) => {
  const n = Object.keys(kinds).length % 4;
  kinds[lid] = ['private', 'agency', 'nophone', 'fetcherror'][n];
  return kinds[lid];
});
eq('agency + private + blank + error all handled', [r2.summary.written_to_sheet, r2.summary.errors_logged], [9, 3]);
ok('agency name extracted', r2.results.some(x => x.advertiser_name === 'Alfa Nekretnine DOO'), r2.results.map(x => x.advertiser_name));
const blank = r2.results.find(x => x.phone === '');
ok('missing phone left blank, row still written', blank && blank.advertiser_name === 'Ana Jovanović', blank);
ok('blank field counted', r2.summary.rows_with_a_blank_field === 3, r2.summary.rows_with_a_blank_field);
ok('errors carry link + message + category',
   r2.errors.every(e => e.link && e.error_message && e.category), r2.errors[0]);
eq('error rows still balance', r2.summary.unaccounted, 0);

/* --- a search-page URL must never reach Results as a price with no contact --- */
{
  const searchUrlPage = (n) => CHROME + BULK + '<body><main>' +
    '<article><a href="/prodaja-stanova/vracar-beograd/trosoban-stan/' + id(7000 + n) + '">ok</a><p>250.000 €</p></article>' +
    '<article><a href="/prodaja-stanova/beograd/' + id(8000 + n) + '">search page</a><p>300.000 €</p></article>' +
    '</main></body></html>';
  PRICES[id(7000)] = 250000;
  const rs = runWorkflow({ max_pages: 1 },
    (url) => ({ body: /strana=/.test(url) ? CHROME + BULK + '<body><main></main></body></html>' : searchUrlPage(0), status: 200 }));
  eq('non-listing url shape is rejected before costing a request', rs.summary.stage1_rejected_not_a_listing_url, 1);
  ok('the rejected url is reported for inspection',
     /\/prodaja-stanova\/beograd\//.test(rs.summary.rejected_url_samples[0] || ''), rs.summary.rejected_url_samples);
  eq('only the real listing was queued', rs.summary.detail_pages_queued, 1);
}
{
  // even if such a url slipped through, a page with no advertiser block goes to Errors
  const bare = CHROME + BULK + '<body><h1>Pretraga</h1><div>250.000 €</div></body></html>';
  const rs = runWorkflow({ max_pages: 1 },
    (url) => ({ body: /strana=/.test(url) ? CHROME + BULK + '<body><main></main></body></html>'
      : CHROME + BULK + '<body><main><article><a href="/prodaja-stanova/vracar-beograd/trosoban-stan/' + id(7100) +
        '">x</a><p>250.000 €</p></article></main></body></html>', status: 200 }),
    () => 'searchpage');
  eq('page with no advertiser block is logged as an error, not written', [rs.summary.written_to_sheet, rs.summary.errors_logged], [0, 1]);
  eq('and is counted separately', rs.summary.errors_no_advertiser_block, 1);
  ok('the error names the cause', /no advertiser block/.test(rs.errors[0].error_message), rs.errors[0].error_message);
  ok('the bad link is preserved for inspection', !!rs.errors[0].link);
}

/* ---- end of results by page repetition (site clamps instead of emptying) ---- */
const clampServe = (url) => {
  const m = url.match(/strana=(\d+)/); const p = m ? Number(m[1]) : 1;
  return { body: (pages[Math.min(p, 3)] = pages[Math.min(p, 3)] || listPage(Math.min(p, 3), 12)), status: 200 };
};
const r3 = runWorkflow({}, clampServe);
ok('stops when the site clamps to the last page', /repeats_page/.test(r3.summary.stop_reason), r3.summary.stop_reason);

/* the site clamps out-of-range pages back to page 1, not to the last page */
const clampToFirst = (url) => {
  const m = url.match(/strana=(\d+)/); const p = m ? Number(m[1]) : 1;
  const eff = p > 3 ? 1 : p;
  return { body: (pages[eff] = pages[eff] || listPage(eff, 12)), status: 200 };
};
const r3b = runWorkflow({}, clampToFirst);
ok('stops when an out-of-range page clamps back to page 1 (not just the previous page)',
   /repeats_page_1/.test(r3b.summary.stop_reason), r3b.summary.stop_reason);
ok('clamped run did not spin to the hard cap', r3b.summary.pages_fetched < 10, r3b.summary.pages_fetched);

/* ---- bot block stops the run ---- */
const r4 = runWorkflow({}, (url) => /strana=2/.test(url)
  ? { body: '<html><title>Just a moment...</title></html>', status: 200 }
  : serve(url));
ok('block detected and surfaced', r4.blocked && r4.blocked.blocked === true, r4.blocked);
eq('block reason reported', r4.blocked.block_reason, 'challenge_page');

/* ---- resume ---- */
const r5 = runWorkflow({ resume_from_page: 3 }, serve);
eq('resume: calibrates on page 1 then jumps', r5.fetched, [
  'https://www.4zida.rs/prodaja-stanova',
  'https://www.4zida.rs/prodaja-stanova?strana=3',
  'https://www.4zida.rs/prodaja-stanova?strana=4']);
eq('resume: only page 3 scanned', r5.summary.stage1_listings_scanned, 12);

const firstId = r.results[0].listing_id;
const r6 = runWorkflow({ resume_after_listing_id: firstId }, serve);
eq('resume_after_listing_id skips already-written rows', r6.summary.resume_skipped, 1);
eq('resume: writes the rest', r6.summary.written_to_sheet, 11);

/* ---- max_pages guard ---- */
const r7 = runWorkflow({ max_pages: 2 }, serve);
ok('max_pages honoured', /max_pages_reached_2/.test(r7.summary.stop_reason), r7.summary.stop_reason);

/* ---- zero qualifying listings (the expected garages case) ---- */
const cheap = CHROME + BULK + '<body><main>' +
  '<article><a href="/prodaja-garaza-i-parkinga/vozdovac/garaza/' + id(9001) + '">G</a><p>12.000 €</p></article>' +
  '</main></body></html>';
const r8 = runWorkflow({ category_base_url: 'https://www.4zida.rs/prodaja-garaza-i-parkinga' },
  (url) => ({ body: /strana=/.test(url) ? CHROME + BULK + '<body><main>Nema rezultata</main></body></html>' : cheap, status: 200 }));
eq('no qualifiers is a clean finish, not an error', [r8.summary.written_to_sheet, r8.summary.errors_logged], [0, 0]);
eq('cheap listing was scanned but filtered', [r8.summary.stage1_listings_scanned, r8.summary.stage1_below_threshold], [1, 1]);

/* ---- config invariants ---- */
const cfg = configItems()[0].json;
eq('threshold default', cfg.min_price_eur, 100000);
ok('config carries a real category url by default', /4zida\.rs\/prodaja-/.test(cfg.category_base_url));
let threw = false;
try { runNode('Init Pager', configItems({ category_base_url: 'https://example.com/x' }), { Config: configItems({ category_base_url: 'https://example.com/x' }) }, {}); }
catch (e) { threw = /category_base_url/.test(e.message); }
ok('bad category url fails fast with a clear message', threw);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
