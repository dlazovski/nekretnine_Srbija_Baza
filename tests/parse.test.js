/* Synthetic-fixture tests. These prove the PARSING LOGIC is sound (number
 * formats, per-m2 traps, strategy fallback, block detection). They cannot
 * prove the live 4zida markup matches — that is what the Step 0 probe is for. */
const A = require('../src/lib/parse.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); } }

/* ---- number formats ---- */
eq('sr thousands',      A.normalizeNumberToken('100.000'), 100000);
eq('sr millions',       A.normalizeNumberToken('1.250.000'), 1250000);
eq('sr decimal',        A.normalizeNumberToken('99.500,50'), 99500.5);
eq('space thousands',   A.normalizeNumberToken('123 456'), 123456);
eq('plain',             A.normalizeNumberToken('185000'), 185000);
eq('en thousands',      A.normalizeNumberToken('1,250,000'), 1250000);

/* ---- per-m2 trap ---- */
eq('skips eur per m2', A.parsePriceEur('<div>2.500 €/m²</div><div>245.000 €</div>'), 245000);
eq('skips m2 no slash', A.parsePriceEur('<span>3.100 € m2</span><span>310.000 €</span>'), 310000);
eq('entity euro',      A.parsePriceEur('<b>150.000&nbsp;&euro;</b>'), 150000);

/* ---- list page: DOM-span strategy, mixed cards ---- */
const listHtml = `<html><body><header><a href="/">4zida</a></header><main>
 <article><a href="/prodaja-stanova/vracar-beograd/trosoban-stan/aaaaaaaaaaaaaaaaaaaaaaa1">
   <img src="/_nuxt/deadbeefdeadbeefdeadbeef.jpg"></a>
   <a href="/prodaja-stanova/vracar-beograd/trosoban-stan/aaaaaaaaaaaaaaaaaaaaaaa1">Trosoban</a>
   <p class="p">245.000 €</p><p>3.100 €/m²</p></article>
 <article><a href="/prodaja-stanova/zvezdara-beograd/dvosoban-stan/bbbbbbbbbbbbbbbbbbbbbbb2">Dvosoban</a>
   <p>89.500 €</p></article>
 <article><a href="/prodaja-stanova/nis/jednosoban-stan/ccccccccccccccccccccccc3">Jednosoban</a>
   <p>Cena na upit</p></article>
 <article><a href="/prodaja-stanova/novi-sad/cetvorosoban-stan/ddddddddddddddddddddddd4">Cetvorosoban</a>
   <p>1.250.000 €</p></article></main></body></html>`;
const lp = A.parseListPage(listHtml);
eq('list: 4 listings', lp.listings.length, 4);
ok('list: ignores _nuxt asset hash', lp.listings.every(l => l.listing_id !== 'deadbeefdeadbeefdeadbeef'));
const byId = Object.fromEntries(lp.listings.map(l => [l.listing_id, l]));
eq('list: card1 price', byId['aaaaaaaaaaaaaaaaaaaaaaa1'].price, 245000);
eq('list: card2 price', byId['bbbbbbbbbbbbbbbbbbbbbbb2'].price, 89500);
eq('list: on-request has no price', byId['ccccccccccccccccccccccc3'].price, null);
ok('list: on-request flagged', byId['ccccccccccccccccccccccc3'].price_on_request === true);
eq('list: card4 price', byId['ddddddddddddddddddddddd4'].price, 1250000);
eq('list: absolute url', byId['bbbbbbbbbbbbbbbbbbbbbbb2'].url,
   'https://www.4zida.rs/prodaja-stanova/zvezdara-beograd/dvosoban-stan/bbbbbbbbbbbbbbbbbbbbbbb2');
eq('list: best strategy', lp.diagnostics.best_strategy, 'dom_span');

/* ---- list page: JSON-LD strategy wins when present and exact ---- */
const ldHtml = `<html><body><script type="application/ld+json">
{"@type":"ItemList","itemListElement":[
 {"item":{"@type":"Product","url":"https://www.4zida.rs/prodaja-kuca/cukarica-beograd/kuca/eeeeeeeeeeeeeeeeeeeeeee5","offers":{"@type":"Offer","price":"430000","priceCurrency":"EUR"}}},
 {"item":{"@type":"Product","url":"https://www.4zida.rs/prodaja-kuca/pancevo/kuca/fffffffffffffffffffffff6","offers":{"@type":"Offer","price":"72000","priceCurrency":"EUR"}}}]}
</script><a href="/prodaja-kuca/cukarica-beograd/kuca/eeeeeeeeeeeeeeeeeeeeeee5">k1</a>
<a href="/prodaja-kuca/pancevo/kuca/fffffffffffffffffffffff6">k2</a></body></html>`;
const lp2 = A.parseListPage(ldHtml);
eq('jsonld: strategy chosen', lp2.diagnostics.best_strategy, 'jsonld');
eq('jsonld: price', lp2.listings.find(l => l.listing_id === 'eeeeeeeeeeeeeeeeeeeeeee5').price, 430000);
eq('jsonld: source tagged', lp2.listings.find(l => l.listing_id === 'fffffffffffffffffffffff6').price_source, 'jsonld');

/* ---- list page: hydration-JSON strategy when there is no visible price ---- */
const nuxtHtml = `<html><body><a href="/prodaja-placeva/obrenovac/plac/1111111111111111111111a7">plac</a>
<script>window.__NUXT__={data:[{ads:[{"id":"1111111111111111111111a7","title":"Plac","price":168000,"m2":40}]}]}</script></body></html>`;
const lp3 = A.parseListPage(nuxtHtml);
eq('nuxt: price found', lp3.listings[0].price, 168000);
eq('nuxt: source tagged', lp3.listings[0].price_source, 'json_window');

/* ---- pagination detection ---- */
eq('pg: rel=next query',
   A.detectPaginationTemplate('<link rel="next" href="https://www.4zida.rs/prodaja-stanova?strana=2">', 'https://www.4zida.rs/prodaja-stanova').style, 'query:strana');
eq('pg: anchor path style',
   A.detectPaginationTemplate('<a href="/prodaja-kuca/stranica/2">2</a>', 'https://www.4zida.rs/prodaja-kuca').style, 'path:stranica');
eq('pg: page= query',
   A.detectPaginationTemplate('<a href="/prodaja-stanova?page=3">3</a>', 'https://www.4zida.rs/prodaja-stanova').template,
   'https://www.4zida.rs/prodaja-stanova?page={PAGE}');
eq('pg: none found', A.detectPaginationTemplate('<p>no links</p>', 'https://www.4zida.rs/prodaja-stanova'), null);
eq('pg: fallback url', A.buildPageUrl(null, 'https://www.4zida.rs/prodaja-stanova', 4), 'https://www.4zida.rs/prodaja-stanova?strana=4');
eq('pg: template url', A.buildPageUrl('https://x/y?strana={PAGE}', 'https://x/y', 7), 'https://x/y?strana=7');

/* ---- phones ---- */
eq('ph: +381 mobile',  A.normalizePhone('+381 62 431 2345'), '0624312345');
eq('ph: 00381',        A.normalizePhone('00381641234567'), '0641234567');
eq('ph: slashed',      A.normalizePhone('062/431-234'), '062431234');
eq('ph: landline',     A.normalizePhone('011 2345 678'), '0112345678');
eq('ph: too short',    A.normalizePhone('062 12'), null);

const detailPrivate = `<html><head><script type="application/ld+json">
{"@type":"Product","name":"Trosoban stan","offers":{"@type":"Offer","price":"186000","priceCurrency":"EUR"}}</script></head>
<body><header><a href="tel:+381113334444">Podrska 4zida</a></header>
<main><span class="masked">062 43****</span><button>Prikaži</button>
<script>window.__NUXT__={ad:{"id":"6a91d04359e6b8eb78023435","advertiserName":"Milan Petrović","phone":"+381 62 4312345","price":186000}}</script>
</main><footer><a href="tel:0113334444">kontakt</a></footer></body></html>`;
const d1 = A.parseDetail(detailPrivate, 'https://www.4zida.rs/prodaja-stanova/x/y/6a91d04359e6b8eb78023435');
eq('detail1 price', d1.price_eur, 186000);
eq('detail1 price src', d1.price_source, 'jsonld:offers.price');
eq('detail1 phone', d1.phone, '0624312345');
eq('detail1 phone src', d1.phone_source, 'json:phone');
eq('detail1 advertiser', d1.advertiser_name, 'Milan Petrović');
ok('detail1 demotes header/footer support number',
   d1.all_phones.findIndex(p => p.phone === '0113334444') > 0 || !d1.all_phones.some(p => p.phone === '0113334444'), d1.all_phones);
eq('detail1 no warnings', d1.warnings, []);

const detailAgency = `<html><body><h1>Kuća</h1><div>430.000 €</div><div>2.100 €/m²</div>
<section class="agency"><span itemprop="telephone" content="0631112223"></span>
<script type="application/ld+json">{"@type":"Offer","price":430000,"priceCurrency":"EUR",
"seller":{"@type":"RealEstateAgent","name":"Beograd Nekretnine DOO"}}</script></section></body></html>`;
const d2 = A.parseDetail(detailAgency, 'https://www.4zida.rs/prodaja-kuca/a/b/2222222222222222222222b8');
eq('detail2 price', d2.price_eur, 430000);
eq('detail2 agency name', d2.advertiser_name, 'Beograd Nekretnine DOO');
eq('detail2 phone', d2.phone, '0631112223');

const detailMissing = `<html><body><h1>Garaža</h1><p>Cena na upit</p></body></html>`;
const d3 = A.parseDetail(detailMissing, 'https://www.4zida.rs/prodaja-garaza-i-parkinga/a/b/3333333333333333333333c9');
eq('detail3 blanks not throws', [d3.price_eur, d3.phone, d3.advertiser_name], ['', '', '']);
ok('detail3 warns on-request', d3.warnings.indexOf('price_on_request') !== -1, d3.warnings);
eq('detail3 link preserved', d3.link, 'https://www.4zida.rs/prodaja-garaza-i-parkinga/a/b/3333333333333333333333c9');

const dExcl = A.parseDetail(detailPrivate, 'u', { exclude_phones: ['0624312345'] });
ok('exclude_phones drops the number', dExcl.phone !== '0624312345', dExcl.phone);

/* ---- block detection ---- */
ok('block: cloudflare', A.detectBlock('<html><title>Just a moment...</title></html>', 200).blocked);
ok('block: captcha', A.detectBlock('<html>Please complete the captcha</html>', 200).blocked);
ok('block: 429', A.detectBlock('<html>4zida</html>', 429).blocked);
ok('block: 403', A.detectBlock('', 403).blocked);
eq('block: scrapingbee json reason',
   A.detectBlock('{"message":"Your account has run out of API credits"}', 200).reason, 'scrapingbee_error');
ok('block: tiny stub', A.detectBlock('<html><body>hi</body></html>', 200).blocked);
ok('block: normal page is not blocked', !A.detectBlock(listHtml, 200).blocked);
ok('block: empty-but-valid page is a parse miss, not a block',
   !A.detectBlock('<html><body><div id="app">4zida — nema rezultata za vašu pretragu.</div>' + 'x'.repeat(3000) + '</body></html>', 200).blocked);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
