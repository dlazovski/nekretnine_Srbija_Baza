/* Simulation of the Step 0 probe workflow's shipped jsCode. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const WF = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows/4zida-step0-probe.json'), 'utf8'));
const CODE = Object.fromEntries(WF.nodes.filter(n => n.type === 'n8n-nodes-base.code').map(n => [n.name, n.parameters.jsCode]));
const CFG = WF.nodes.find(n => n.name === 'Probe Config');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')); } };

const store = {}, out = {};
function run(name, items) {
  const ctx = {
    console: { log: () => {} }, JSON, Math, Number, String, Boolean, Object, Array, Date, RegExp, parseInt, parseFloat, isFinite, Error,
    $getWorkflowStaticData: () => store,
    $input: { first: () => items[0], all: () => items },
    $json: items[0] ? items[0].json : {},
    $: (n) => { if (!out[n]) throw new Error("no output for " + n); return { first: () => out[n][0], all: () => out[n] }; }
  };
  return (out[name] = vm.runInNewContext('(function(){\n' + CODE[name] + '\n})', ctx)());
}

const cfg = {}; CFG.parameters.assignments.assignments.forEach(a => cfg[a.name] = a.value);
out['Probe Config'] = [{ json: cfg }];

const targets = run('Build Probe Targets', out['Probe Config']);
ok('probes all 5 categories + 1 out-of-range page', targets.length === 6, targets.map(t => t.json.url));
ok('out-of-range probe present', targets.some(t => t.json.kind === 'list_far'));

const CHROME = '<html lang="sr"><head><title>4zida.rs</title><link rel="next" href="/prodaja-stanova?strana=2"></head>';
const BULK = '<div>' + 'sadrzaj '.repeat(400) + '</div>';
const lid = 'a1b2c3d4e5f60718293a4b5c';
const listHtml = CHROME + BULK + '<body><main><article><a href="/prodaja-stanova/vracar-beograd/trosoban-stan/' +
  lid + '">Stan</a><p>245.000 €</p><p>2.900 €/m²</p></article></main></body></html>';

for (const t of targets) {
  out['Loop Probe A'] = [t];
  const blocked = t.json.kind === 'list_far';
  run('Analyze List Probe', [{ json: { body: blocked ? CHROME + BULK + '<body><main></main></body></html>' : listHtml, statusCode: 200 } }]);
}
ok('list probe recorded every target', Object.keys(store.probe.list).length === 6, Object.keys(store.probe.list));
const first = store.probe.list['list:prodaja-stanova'];
ok('probe reports pagination style', first.pagination_style === 'query:strana', first.pagination_style);
ok('probe reports price coverage', first.price_coverage_pct === 100, first.price_coverage_pct);
ok('probe reports end-of-results signature', !!store.probe.list['list_far:prodaja-stanova'].end_of_results_signature);

const dTargets = run('Build Detail Probe Targets', []);
ok('one detail probe per category', dTargets.length === 5, dTargets.length);

const detailHtml = CHROME + BULK + '<body><span>062 43****</span><script>window.__NUXT__={ad:{"advertiserName":"Milan Petrović","phone":"+381 62 4312345","price":245000}}</script></body></html>';
for (const t of dTargets) {
  out['Loop Probe B'] = [t];
  run('Analyze Detail Probe', [{ json: { body: detailHtml, statusCode: 200 } }]);
}
const rep = run('Build Step 0 Report', [])[0].json;
ok('report covers all 5 categories', rep.per_category.length === 5, rep.per_category.length);
ok('report counts the credits spent', rep.scrapingbee_requests_used === 11, rep.scrapingbee_requests_used);
ok('report confirms phone without render_js', rep.per_category[0].detail_probe.phone_available_without_render_js === true);
ok('report shows the masked display form was present', rep.per_category[0].detail_probe.phone_masked_form_on_page === true);
ok('report includes surrounding HTML for the phone', /advertiserName|phone/.test(rep.per_category[0].detail_probe.phone_context || ''));
ok('clean probe reports no actions', rep.actions_required.length === 1 && /None/.test(rep.actions_required[0]), rep.actions_required);

/* a failing probe must produce actionable instructions, not silence */
const store2 = {}, out2 = {};
(function () {
  const saveStore = store.probe;
  Object.keys(store).forEach(k => delete store[k]);
  out['Probe Config'] = [{ json: cfg }];
  run('Build Probe Targets', out['Probe Config']);
  for (const t of targets) {
    out['Loop Probe A'] = [t];
    run('Analyze List Probe', [{ json: { body: '<html><title>Just a moment...</title></html>', statusCode: 403 } }]);
  }
  const d = run('Build Detail Probe Targets', []);
  ok('no detail probes when list pages are blocked', d.length === 1 && d[0].json._none === true, d);
  const rep2 = run('Build Step 0 Report', [])[0].json;
  ok('blocked probe raises actions', rep2.actions_required.some(a => /BLOCKED/.test(a)), rep2.actions_required);
  store.probe = saveStore;
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
