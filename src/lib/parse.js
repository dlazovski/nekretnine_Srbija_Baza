/* ============================================================================
 * 4zida.rs parsing library  (shared by every Code node in both workflows)
 *
 * IMPORTANT — read docs/ASSUMPTIONS.md before running at scale.
 * Every extractor below is MULTI-STRATEGY: it tries several independent ways
 * of getting a value and reports which one worked (`*_source` fields). Run
 * workflows/4zida-step0-probe.json first: it prints, per category, which
 * strategy actually fired against the live site. If a strategy is wrong you
 * change it HERE (one file) and rebuild, not in nine separate nodes.
 * ==========================================================================*/

var ZIDA_ORIGIN = 'https://www.4zida.rs';

/* ---------------------------------------------------------------- text ---*/

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/* 4zida nests JSON inside JSON: the advertiser block arrives as
 *   "authorData":"{\\"fullName\\":\\"...\\",\\"phones\\":[...]}"
 * so a single unescape pass leaves \\" in place and every "key" pattern misses.
 * Unescape repeatedly until the text stops changing (bounded), which flattens
 * one, two or three levels alike. Idempotent, so it is safe to reapply. */
function deepUnescape(s, maxPasses) {
  var out = String(s == null ? '' : s);
  for (var i = 0; i < (maxPasses || 4); i++) {
    if (out.indexOf('\\') === -1) break;
    var next = out.replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\\//g, '/');
    if (next === out) break;
    out = next;
  }
  return out;
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* --------------------------------------------------------------- price ---*/

/* Serbian number formatting: "." groups thousands, "," is the decimal mark.
 * "100.000 €" -> 100000 ; "1.250.000 €" -> 1250000 ; "99.500,50 €" -> 99500.5 */
function normalizeNumberToken(tok) {
  var t = String(tok).replace(/[\s  ']/g, '');
  var hasDot = t.indexOf('.') !== -1;
  var hasCom = t.indexOf(',') !== -1;
  if (hasDot && hasCom) {
    // whichever separator comes last is the decimal mark
    t = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (hasCom) {
    t = /,\d{3}(\D|$)/.test(t + ' ') && !/,\d{1,2}$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (hasDot) {
    // "100.000" is thousands; "1.5" (rare here) would be decimal
    t = /\.\d{3}(\.|$)/.test(t) ? t.replace(/\./g, '') : t;
  }
  var n = parseFloat(t);
  return isFinite(n) ? n : null;
}

/* True when the € amount at `idx` is a per-square-metre figure (2.500 €/m²),
 * which must never be mistaken for the listing price. */
function isPerSquareMetre(html, idx) {
  var after = html.slice(idx, idx + 40).toLowerCase();
  return /^\s*(\/|\s)?\s*(m\s*(2|²|\^2)|po\s*m|\/\s*m)/.test(after.replace(/<[^>]*>/g, ''));
}

var PRICE_ON_REQUEST = /(cena\s*na\s*upit|na\s*upit|po\s*dogovoru|dogovor)/i;

/* Returns every EUR amount in a chunk of HTML, per-m2 figures excluded. */
function findPriceCandidates(rawChunk) {
  // Normalise the entity forms of the euro sign and of non-breaking space so a
  // single regex covers "150.000&nbsp;&euro;" and "150.000 €" alike.
  var chunk = String(rawChunk || '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&euro;|&#8364;|&#x20ac;/gi, '€');
  var out = [];
  var re = /(\d[\d.,\s ]{2,})\s*(?:€|&euro;|&#8364;|EUR\b|eura?\b)/gi;
  var m;
  while ((m = re.exec(chunk)) !== null) {
    var end = m.index + m[0].length;
    if (isPerSquareMetre(chunk, end)) continue;
    var v = normalizeNumberToken(m[1]);
    if (v !== null && v >= 100) out.push({ value: Math.round(v), raw: m[0].trim(), at: m.index });
  }
  // "€ 123.456" (symbol first) — rarer, but cheap to also cover
  var re2 = /(?:€|EUR)\s*(\d[\d.,\s ]{2,})/gi;
  while ((m = re2.exec(chunk)) !== null) {
    var v2 = normalizeNumberToken(m[1]);
    if (v2 !== null && v2 >= 100) out.push({ value: Math.round(v2), raw: m[0].trim(), at: m.index });
  }
  return out.sort(function (a, b) { return a.at - b.at; });
}

/* The displayed listing price is the FIRST non-per-m2 amount in the card. */
function parsePriceEur(chunk) {
  var c = findPriceCandidates(chunk);
  return c.length ? c[0].value : null;
}

/* ------------------------------------------------------------- JSON-LD ---*/

function extractJsonLd(html) {
  var out = [], re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, m;
  while ((m = re.exec(html)) !== null) {
    try {
      var parsed = JSON.parse(decodeEntities(m[1]).trim());
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(function (o) { out.push(o); });
    } catch (e) { /* malformed block — ignore, other strategies still apply */ }
  }
  return out;
}

/* Depth-first walk over any parsed structure. */
function walk(node, fn, depth) {
  depth = depth || 0;
  if (!node || depth > 12) return;
  if (Array.isArray(node)) { node.forEach(function (n) { walk(n, fn, depth + 1); }); return; }
  if (typeof node === 'object') {
    fn(node);
    Object.keys(node).forEach(function (k) { walk(node[k], fn, depth + 1); });
  }
}

/* ------------------------------------------------------------ listings ---*/

/* 4zida listing URLs end in a 24-char hex id (Mongo ObjectId), e.g.
 * /prodaja-stanova/hram-svetog-save-vracar-beograd/trosoban-stan/6a91d04359e6b8eb78023435
 * Anchoring on that shape is category-agnostic and survives CSS/class churn. */
var LISTING_PATH_RE = /\/(?:prodaja|izdavanje)-[a-z0-9šđčćž-]+(?:\/[a-z0-9šđčćž._-]+)*\/([0-9a-f]{24})(?![0-9a-z])/gi;

function listingIdFromUrl(url) {
  var m = String(url || '').match(/([0-9a-f]{24})(?:[/?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function absolutize(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path.split('#')[0];
  return ZIDA_ORIGIN + (path.charAt(0) === '/' ? '' : '/') + path;
}

/* All listing links on a page, in document order, first occurrence per id.
 * `pos` is where that id is first mentioned — used to slice cards apart. */
function findListingLinks(html) {
  var seen = Object.create(null), out = [];
  var src = html.replace(/\\\//g, '/');           // un-escape JSON-embedded hrefs
  LISTING_PATH_RE.lastIndex = 0;
  var m;
  while ((m = LISTING_PATH_RE.exec(src)) !== null) {
    var path = m[0], id = m[1].toLowerCase();
    if (/_nuxt|\.(?:js|css|png|jpe?g|webp|svg|woff2?)$/i.test(path)) continue;
    if (seen[id]) continue;
    seen[id] = true;
    out.push({ id: id, url: absolutize(path), pos: m.index });
  }
  return out;
}

/* ------------------------------------------------- list page: 3 strategies */

/* Strategy A — JSON-LD ItemList/Product carrying url + offers.price.
 * Exact when present; needs no DOM knowledge at all. */
function listFromJsonLd(html) {
  var byId = Object.create(null);
  extractJsonLd(html).forEach(function (root) {
    walk(root, function (o) {
      var url = o.url || o['@id'] || (o.item && (o.item.url || o.item['@id']));
      var id = listingIdFromUrl(url);
      if (!id) return;
      var offers = o.offers || (o.item && o.item.offers) || {};
      var raw = offers.price != null ? offers.price : (Array.isArray(offers) && offers[0] ? offers[0].price : null);
      var cur = offers.priceCurrency || (Array.isArray(offers) && offers[0] ? offers[0].priceCurrency : '');
      var price = raw == null ? null : normalizeNumberToken(raw);
      if (cur && String(cur).toUpperCase() !== 'EUR') price = null;   // never mix currencies
      if (!byId[id] || (byId[id].price == null && price != null)) {
        byId[id] = { id: id, url: absolutize(url), price: price == null ? null : Math.round(price) };
      }
    });
  });
  return Object.keys(byId).map(function (k) { return byId[k]; });
}

/* Every occurrence of a known listing id, in document order. These are the
 * boundaries that keep one listing's price from being read as another's. */
function idOccurrences(src, knownIds) {
  var out = [], re = /[0-9a-f]{24}/g, m;
  while ((m = re.exec(src)) !== null) {
    var v = m[0].toLowerCase();
    if (!knownIds || knownIds[v]) out.push({ id: v, at: m.index });
  }
  return out;
}

/* The JSON object that encloses `at`, as [start, end). Scanning outward for the
 * balanced braces is what makes price attribution exact: a listing's price is
 * whatever sits inside ITS OWN object, never whatever happens to be nearby. */
function enclosingObjectSpan(src, at, maxScan) {
  maxScan = maxScan || 8000;
  var depth = 0, start = -1, i, c;
  for (i = at; i >= Math.max(0, at - maxScan); i--) {
    c = src.charAt(i);
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start === -1) return null;
  depth = 0;
  var inStr = false, esc = false, limit = Math.min(src.length, start + maxScan * 2);
  for (i = start; i < limit; i++) {
    c = src.charAt(i);
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return [start, i + 1]; }
  }
  return null;
}

var PRICE_KEY_RE = /"(?:price|cena|priceEur|price_eur|totalPrice)"\s*:\s*"?(\d[\d.,]*)"?/gi;

function firstPriceIn(chunk) {
  PRICE_KEY_RE.lastIndex = 0;
  var m;
  while ((m = PRICE_KEY_RE.exec(chunk)) !== null) {
    var v = normalizeNumberToken(m[1]);
    if (v !== null && v >= 100) return Math.round(v);
  }
  return null;
}

/* The price belonging to `id`. Preferred: the price inside the same JSON object
 * as the id. Fallback: the region bounded by the neighbouring listing ids, so
 * even then one listing's price can never be read as another's.
 *
 * A fixed window around the id — which is what this used to be — silently
 * stole the neighbour's price whenever listing objects were packed together,
 * shifting the price of every listing after the first. */
function priceNearId(src, id, occ) {
  var fallback = null;
  for (var i = 0; i < occ.length; i++) {
    if (occ[i].id !== id) continue;
    var at = occ[i].at;

    var span = enclosingObjectSpan(src, at);
    if (span) {
      var p = firstPriceIn(src.slice(span[0], span[1]));
      if (p !== null) return p;
    }

    if (fallback === null) {
      var lo = 0, hi = src.length, j, k;
      for (j = i - 1; j >= 0; j--) if (occ[j].id !== id) { lo = occ[j].at; break; }
      for (k = i + 1; k < occ.length; k++) if (occ[k].id !== id) { hi = occ[k].at; break; }
      fallback = firstPriceIn(src.slice(at, Math.min(hi, at + 4000)));
      if (fallback === null) fallback = firstPriceIn(src.slice(Math.max(lo, at - 4000), at));
    }
  }
  return fallback;
}

/* Strategy B — hydration/embedded JSON, id-anchored. */
function listFromJsonWindow(src, links) {
  var known = Object.create(null);
  links.forEach(function (l) { known[l.id] = true; });
  var occ = idOccurrences(src, known);
  return links.map(function (l) {
    return { id: l.id, url: l.url, price: priceNearId(src, l.id, occ) };
  });
}

/* Strategy C — DOM slicing: a card runs from one listing link to the next, so
 * the price inside that span belongs to that listing. Falls back to a lookbehind
 * window for layouts that render the price above the link. */
function listFromDomSpans(html, links) {
  return links.map(function (l, i) {
    var end = (i + 1 < links.length) ? links[i + 1].pos : Math.min(html.length, l.pos + 4000);
    var price = parsePriceEur(html.slice(l.pos, end));
    var onRequest = PRICE_ON_REQUEST.test(stripTags(html.slice(l.pos, end)));
    if (price === null && !onRequest) {
      var back = html.slice(Math.max(0, l.pos - 1200), l.pos);
      var c = findPriceCandidates(back);
      if (c.length) price = c[c.length - 1].value;      // nearest one above the link
    }
    return { id: l.id, url: l.url, price: price, price_on_request: onRequest };
  });
}

/* Runs all three, prefers the strategy with the best price coverage, and
 * back-fills gaps from the others. Returns diagnostics for the probe report. */
function parseListPage(html) {
  var src = deepUnescape(html);
  var links = findListingLinks(html);
  // Blank the ld+json blocks (keeping length, so offsets stay valid) before the
  // payload scan, so the two strategies read genuinely independent sources and
  // a disagreement between them is real evidence rather than an echo.
  var payloadSrc = src.replace(/(<script[^>]+application\/ld\+json[^>]*>)([\s\S]*?)(<\/script>)/gi,
    function (_, open, body, close) { return open + body.replace(/[^\n]/g, ' ') + close; });
  var strategies = {
    jsonld: listFromJsonLd(html),
    json_window: listFromJsonWindow(payloadSrc, links),
    dom_span: listFromDomSpans(html, links)
  };

  var coverage = {}, best = null;
  ['jsonld', 'json_window', 'dom_span'].forEach(function (name) {
    var rows = strategies[name];
    var withPrice = rows.filter(function (r) { return r.price != null; }).length;
    coverage[name] = { rows: rows.length, with_price: withPrice };
    if (!best || withPrice > coverage[best].with_price) best = name;
  });

  // JSON-LD pairs a url with its own offers.price inside one object, so it is
  // exact by construction and is always trusted first; the id-anchored payload
  // scan fills in listings JSON-LD omits; the DOM scan is the last resort.
  var PREFERENCE = ['jsonld', 'json_window', 'dom_span'];

  var merged = Object.create(null);
  (links.length ? links : strategies.jsonld).forEach(function (l) {
    merged[l.id] = { listing_id: l.id, url: l.url, price: null, price_source: null, price_on_request: false };
  });
  PREFERENCE.forEach(function (name) {
    strategies[name].forEach(function (r) {
      if (!merged[r.id]) merged[r.id] = { listing_id: r.id, url: r.url, price: null, price_source: null, price_on_request: false };
      if (r.price_on_request) merged[r.id].price_on_request = true;
      if (merged[r.id].price == null && r.price != null) {
        merged[r.id].price = r.price;
        merged[r.id].price_source = name;
      }
    });
  });

  // Two independent strategies disagreeing about the same listing means one of
  // them is mis-attributing prices. Surfaced rather than silently resolved.
  var byId = {};
  PREFERENCE.forEach(function (name) {
    strategies[name].forEach(function (r) { (byId[r.id] = byId[r.id] || {})[name] = r.price; });
  });
  var disagreements = [];
  Object.keys(byId).forEach(function (k) {
    var a = byId[k].jsonld, b = byId[k].json_window;
    if (a != null && b != null && a !== b) disagreements.push({ listing_id: k, jsonld: a, json_window: b });
  });

  // Adjacent listings sharing a price is the fingerprint of the neighbour-theft bug.
  var listings = Object.keys(merged).map(function (k) { return merged[k]; });
  var adjacentDupes = 0;
  for (var i = 1; i < listings.length; i++) {
    if (listings[i].price != null && listings[i].price === listings[i - 1].price) adjacentDupes++;
  }

  return {
    listings: listings,
    diagnostics: {
      links_found: links.length,
      best_strategy: best,
      preferred_order: PREFERENCE,
      coverage: coverage,
      priced: listings.filter(function (l) { return l.price != null; }).length,
      unpriced: listings.filter(function (l) { return l.price == null; }).length,
      strategy_disagreements: disagreements.slice(0, 10),
      strategy_disagreement_count: disagreements.length,
      adjacent_duplicate_prices: adjacentDupes
    }
  };
}

/* ---------------------------------------------------------- pagination ---*/

/* Reads the real pagination pattern off page 1 instead of guessing it.
 * Returns a template with {PAGE}, e.g. "https://www.4zida.rs/prodaja-stanova?strana={PAGE}" */
function detectPaginationTemplate(html, baseUrl) {
  var src = html.replace(/\\\//g, '/').replace(/&amp;/gi, '&');
  var cands = [];

  var relNext = src.match(/<link[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i)
             || src.match(/<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i);
  if (relNext) cands.push({ href: relNext[1], via: 'rel=next' });

  var basePath = baseUrl.replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/$/, '');
  var re = new RegExp('href=["\']((?:https?://[^"\'/]+)?' + basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                      '(?:/(?:strana|stranica|page)/(\\d+)|\\?[^"\']*?(?:strana|stranica|page|p)=(\\d+)[^"\']*))["\']', 'gi');
  var m;
  while ((m = re.exec(src)) !== null) cands.push({ href: m[1], via: 'pagination-anchor', page: m[2] || m[3] });

  for (var i = 0; i < cands.length; i++) {
    var href = absolutize(cands[i].href);
    var seg = href.match(/\/(strana|stranica|page)\/(\d+)\b/i);
    if (seg) return { template: href.replace(seg[0], '/' + seg[1] + '/{PAGE}'), style: 'path:' + seg[1], via: cands[i].via };
    var qs = href.match(/[?&](strana|stranica|page|p)=(\d+)/i);
    if (qs) {
      var key = qs[1];
      var stripped = href.replace(new RegExp('([?&])' + key + '=\\d+', 'i'), '$1' + key + '={PAGE}');
      return { template: stripped, style: 'query:' + key, via: cands[i].via };
    }
  }
  return null;
}

function buildPageUrl(template, baseUrl, page) {
  if (page <= 1 && !template) return baseUrl;
  if (template) return template.replace('{PAGE}', String(page));
  return baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 'strana=' + page;  // documented fallback
}

/* --------------------------------------------------- ScrapingBee request ---*/

/* Builds the ScrapingBee endpoint URL. Optional parameters are OMITTED rather
 * than sent empty, because ScrapingBee rejects some combinations outright:
 * country_code is only accepted alongside a premium/stealth proxy, so sending
 * country_code=rs with premium_proxy=false makes EVERY request fail. The
 * api_key is appended by the n8n credential, never built in here. */
function scrapingBeeUrl(targetUrl, cfg) {
  cfg = cfg || {};
  var renderJs = cfg.render_js === true || String(cfg.render_js).toLowerCase() === 'true';
  var premium = cfg.premium_proxy === true || String(cfg.premium_proxy).toLowerCase() === 'true';
  var qs = ['url=' + encodeURIComponent(targetUrl), 'render_js=' + (renderJs ? 'true' : 'false')];
  if (premium) {
    qs.push('premium_proxy=true');
    var cc = String(cfg.country_code || '').trim();
    if (cc) qs.push('country_code=' + encodeURIComponent(cc));
  }
  return 'https://app.scrapingbee.com/api/v1/?' + qs.join('&');
}

/* The HTTP nodes continue on failure, so a request that exhausted its retries
 * arrives as an item carrying `error` instead of `body`. */
function isFetchError(item) {
  return !!item && item.error !== undefined && item.body === undefined && item.data === undefined;
}

/* Squeezes every readable detail out of an n8n error item. The terse
 * `error.message` alone hides the upstream service's actual complaint, which
 * is exactly the thing worth reporting. */
function describeFetchError(item) {
  var e = item && item.error;
  if (e === undefined || e === null) return 'unknown fetch error';
  if (typeof e === 'string') return e.slice(0, 500);
  var parts = [];
  if (e.httpCode || e.status) parts.push('HTTP ' + (e.httpCode || e.status));
  if (e.message) parts.push(String(e.message));
  if (e.description && String(e.description) !== String(e.message)) parts.push(String(e.description));
  var c = e.cause;
  if (c) {
    if (typeof c === 'string') parts.push(c);
    else if (c.message) parts.push(String(c.message));
    else { try { parts.push(JSON.stringify(c)); } catch (x) { /* not serialisable */ } }
  }
  if (!parts.length) { try { parts.push(JSON.stringify(e)); } catch (x) { parts.push(String(e)); } }
  return parts.join(' | ').slice(0, 500);
}

/* ------------------------------------------------- bot / block detection ---*/

/* Distinguishes "we are blocked" from "we parsed nothing". The two need very
 * different responses: the first must stop the run, the second must not. */
var BLOCK_MARKERS = [
  /just a moment/i, /cf-browser-verification/i, /cf_chl_/i, /challenge-platform/i,
  /attention required/i, /access denied/i, /request blocked/i, /you have been blocked/i,
  /captcha/i, /recaptcha/i, /hcaptcha/i, /ddos protection/i, /are you a robot/i,
  /unusual traffic/i, /rate limit/i, /too many requests/i
];

function detectBlock(body, statusCode) {
  var html = String(body || '');
  var code = Number(statusCode || 0);

  // ScrapingBee itself failed (bad key, out of credits, upstream refused)
  if (html && html.length < 4000 && /^\s*\{/.test(html)) {
    try {
      var j = JSON.parse(html);
      if (j && (j.message || j.error)) {
        return { blocked: true, reason: 'scrapingbee_error', detail: String(j.message || j.error).slice(0, 300) };
      }
    } catch (e) { /* not ScrapingBee JSON */ }
  }
  if (code === 401 || code === 403) return { blocked: true, reason: 'http_' + code, detail: 'Authorisation/forbidden from ScrapingBee or target' };
  if (code === 429) return { blocked: true, reason: 'http_429', detail: 'Rate limited' };
  for (var i = 0; i < BLOCK_MARKERS.length; i++) {
    if (BLOCK_MARKERS[i].test(html)) {
      return { blocked: true, reason: 'challenge_page', detail: 'matched ' + BLOCK_MARKERS[i] };
    }
  }
  // A real 4zida page is large and mentions the brand; a stub that does not is suspect.
  if (code === 200 && html.length > 0 && html.length < 2000 && !/4zida/i.test(html)) {
    return { blocked: true, reason: 'suspicious_stub', detail: 'HTTP 200 but ' + html.length + ' bytes with no site markers' };
  }
  return { blocked: false, reason: '', detail: '' };
}

/* --------------------------------------------------------------- phone ---*/

/* Serbian numbers: mobile 06x, landline 0(1x|2x|3x). Accepts +381 / 00381
 * forms and any of space, /, -, . as separators. */
var PHONE_RE = /(?:(?:\+|00)381[\s\-./]*|0)(6\d|1[1-9]|2\d|3[0-9])[\s\-./]?(\d{3})[\s\-./]?(\d{2,4})(?!\d)/g;

function normalizePhone(raw) {
  if (!raw) return null;
  var d = String(raw).replace(/[^\d+]/g, '');
  if (d.indexOf('00381') === 0) d = '0' + d.slice(5);
  else if (d.indexOf('+381') === 0) d = '0' + d.slice(4);
  else if (d.indexOf('381') === 0 && d.length >= 11) d = '0' + d.slice(3);
  d = d.replace(/\D/g, '');
  if (d.charAt(0) !== '0') d = '0' + d;
  if (d.length < 9 || d.length > 10) return null;
  return d;
}

/* Regions of the page that belong to the site chrome, not to the advertiser. */
function chromeRanges(html) {
  var ranges = [];
  [/<header[\s\S]*?<\/header>/gi, /<footer[\s\S]*?<\/footer>/gi, /<nav[\s\S]*?<\/nav>/gi].forEach(function (re) {
    var m; while ((m = re.exec(html)) !== null) ranges.push([m.index, m.index + m[0].length]);
  });
  return ranges;
}
function inRanges(ranges, pos) {
  for (var i = 0; i < ranges.length; i++) if (pos >= ranges[i][0] && pos <= ranges[i][1]) return true;
  return false;
}

/* Numbers belonging to 4zida itself. Confirmed in Step 0: every listing page
 * carries the site's own Organization block —
 *   "telephone":"+381244155869","email":"info@4zida.rs" (Subotica office)
 * — and without this it outranks the advertiser's real number on every row,
 * turning the Phone column into one constant, useless value. */
var SITE_PHONES = ['0244155869'];

/* Ranked by how specific the key is to THIS listing. "phones" is the listing's
 * own array of contact numbers; "telephone" is generic schema.org and in
 * practice is the site switchboard, so it sits below everything listing-owned. */
var PHONE_KEY_RANKS = {
  phones: 5, publicphones: 5, phone: 8, phonenumber: 8, phone_number: 8,
  mobile: 8, mobilni: 8, contactphone: 8, telefon: 10, telephone: 30
};

/* A number sitting inside a block that names the site is the site's own. */
function looksSiteOwned(src, pos) {
  return pos != null && /4zida/i.test(src.slice(Math.max(0, pos - 400), pos + 400));
}

/* Ranked phone candidates, best first. Listing-specific keys outrank generic
 * ones; site chrome and 4zida's own contact block are pushed to the bottom;
 * ties are broken by proximity to the listing this page is about. */
function extractPhones(html, excludeList, anchorPos) {
  var excl = SITE_PHONES.concat(excludeList || []).map(normalizePhone).filter(Boolean);
  var src = deepUnescape(html);
  var chrome = chromeRanges(src);
  var found = [], seen = Object.create(null);

  function push(rawVal, source, rank, pos) {
    var n = normalizePhone(rawVal);
    if (!n || excl.indexOf(n) !== -1) return;
    var eff = rank;
    if (pos != null && inRanges(chrome, pos)) eff += 100;
    if (looksSiteOwned(src, pos)) eff += 200;
    if (anchorPos != null && pos != null) eff += Math.min(1.5, Math.abs(pos - anchorPos) / 50000);
    if (seen[n] != null) {
      if (eff < found[seen[n]].rank) { found[seen[n]].rank = eff; found[seen[n]].source = source; }
      return;
    }
    seen[n] = found.length;
    found.push({ phone: n, raw: String(rawVal).trim(), source: source, rank: eff });
  }

  var m;
  // 1. explicit phone-carrying keys in the embedded payload
  var reKey = /"(phones|publicPhones|phone|phoneNumber|phone_number|telefon|telephone|mobile|mobilni|contactPhone)"\s*:\s*(\[[^\]]*\]|"[^"]{6,25}")/gi;
  while ((m = reKey.exec(src)) !== null) {
    var key = m[1], at = m.index, rank = PHONE_KEY_RANKS[key.toLowerCase()] || 12;
    String(m[2]).replace(/"([^"]{6,25})"/g, function (_, v) { push(v, 'json:' + key, rank, at); return _; });
  }
  // 1b. 4zida's phone entries are objects, not strings:
  //     "phones":[{"full":"+381693422234","isViber":false,"national":"069 3422234",...}]
  //     so the number sits under "full"/"national" and the array regex alone misses it.
  var reFull = /"(full|national)"\s*:\s*"([+\d][^"]{5,24})"/gi;
  while ((m = reFull.exec(src)) !== null) push(m[2], 'json:phones.' + m[1], 6, m.index);

  // 2. tel: links and data-* attributes
  var reTel = /(?:href=["']tel:([^"']+)["']|data-(?:phone|telefon|tel)=["']([^"']+)["'])/gi;
  while ((m = reTel.exec(src)) !== null) push(m[1] || m[2], m[1] ? 'tel-href' : 'data-attr', 20, m.index);
  // 3. microdata
  var reMicro = /itemprop=["'](?:telephone|phone)["'][^>]*content=["']([^"']+)["']/gi;
  while ((m = reMicro.exec(src)) !== null) push(m[1], 'microdata', 25, m.index);
  // 4. loose numbers anywhere in the raw HTML (documented fallback)
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(src)) !== null) push(m[0], 'raw-html', 50, m.index);

  found.sort(function (a, b) { return a.rank - b.rank; });
  return found;
}

/* ---------------------------------------------------------- advertiser ---*/

var NAME_KEYS = /"(advertiserName|advertiser|agencyName|agency|companyName|sellerName|seller|ownerName|owner|contactName|contactPerson|authorName|author|displayName|fullName|oglasivac|agencija)"\s*:\s*(?:"([^"]{2,80})"|\{[^{}]*?"(?:name|title|fullName|displayName)"\s*:\s*"([^"]{2,80})")/gi;

function plausibleName(s) {
  var t = decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 80) return null;
  if (/^4\s*zida$/i.test(t) || /4zida/i.test(t)) return null;          // the site itself
  if (/^(null|undefined|true|false|\d+)$/i.test(t)) return null;
  if (/^\$/.test(t)) return null;              // Next.js flight reference, e.g. "$7e"
  if (/^[0-9a-f]{16,}$/i.test(t)) return null;  // bare hash/id
  if (!/[A-Za-zČĆŠĐŽčćšđž]/.test(t)) return null;
  if (/^(https?:|www\.|\/)/i.test(t)) return null;
  return t;
}

function extractAdvertiser(html, phoneRaw) {
  var src = deepUnescape(html);
  var cands = [], m;

  // 1. hydration JSON keys that name an advertiser
  while ((m = NAME_KEYS.exec(src)) !== null) {
    var v = plausibleName(m[2] || m[3]);
    if (v) cands.push({ name: v, source: 'json:' + m[1], rank: 10 });
  }
  // 2. JSON-LD seller / provider / author / agent
  extractJsonLd(html).forEach(function (root) {
    walk(root, function (o) {
      ['seller', 'provider', 'author', 'agent', 'broker', 'offeredBy'].forEach(function (k) {
        var v = o[k] && plausibleName(typeof o[k] === 'string' ? o[k] : o[k].name);
        if (v) cands.push({ name: v, source: 'jsonld:' + k, rank: 15 });
      });
      if ((o['@type'] === 'RealEstateAgent' || o['@type'] === 'Person') && plausibleName(o.name)) {
        cands.push({ name: plausibleName(o.name), source: 'jsonld:' + o['@type'], rank: 20 });
      }
    });
  });
  // 3. DOM fallback: the nearest short text line above the phone number
  if (phoneRaw) {
    var at = src.indexOf(phoneRaw);
    if (at > 0) {
      var before = stripTags(src.slice(Math.max(0, at - 700), at));
      var parts = before.split(/[|•·•]|\s{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
      for (var i = parts.length - 1; i >= 0 && i >= parts.length - 6; i--) {
        var p = plausibleName(parts[i]);
        if (p && p.length <= 60 && /[A-Za-zČĆŠĐŽčćšđž]{2,}/.test(p) && !/\d{3,}/.test(p)) {
          cands.push({ name: p, source: 'dom-near-phone', rank: 60 });
          break;
        }
      }
    }
  }
  cands.sort(function (a, b) { return a.rank - b.rank; });
  return cands;
}

/* ---------------------------------------------------- detail page parse ---*/

function parseDetail(html, url, opts) {
  opts = opts || {};
  var warnings = [];
  var src = deepUnescape(html);

  // A detail page also carries "similar listings", each with its own price and
  // sometimes its own contact. Anchor everything to the id in the URL so those
  // neighbours can never be read as this listing's data.
  var targetId = listingIdFromUrl(url);
  var known = Object.create(null);
  findListingLinks(html).forEach(function (l) { known[l.id] = true; });
  if (targetId) known[targetId] = true;
  var occ = idOccurrences(src, known);
  var anchorPos = null;
  for (var i = 0; i < occ.length; i++) if (occ[i].id === targetId) { anchorPos = occ[i].at; break; }

  var priceCands = [];
  extractJsonLd(html).forEach(function (root) {
    walk(root, function (o) {
      var offers = o.offers;
      if (!offers) return;
      (Array.isArray(offers) ? offers : [offers]).forEach(function (of) {
        if (of && of.price != null && (!of.priceCurrency || String(of.priceCurrency).toUpperCase() === 'EUR')) {
          var v = normalizeNumberToken(of.price);
          if (v != null) priceCands.push({ value: Math.round(v), source: 'jsonld:offers.price' });
        }
      });
    });
  });
  if (!priceCands.length && targetId) {
    var anchored = priceNearId(src, targetId, occ);
    if (anchored != null) priceCands.push({ value: anchored, source: 'json-key:id-anchored' });
  }
  if (!priceCands.length) {
    var mj = src.match(/"(?:price|cena|priceEur|price_eur)"\s*:\s*"?(\d[\d.,]*)"?/i);
    if (mj) { var vj = normalizeNumberToken(mj[1]); if (vj != null && vj >= 100) priceCands.push({ value: Math.round(vj), source: 'json-key:first-match' }); }
  }
  if (!priceCands.length) {
    var vh = parsePriceEur(html);
    if (vh != null) priceCands.push({ value: vh, source: 'html-regex' });
  }
  if (!priceCands.length && PRICE_ON_REQUEST.test(stripTags(html))) warnings.push('price_on_request');
  if (!priceCands.length) warnings.push('price_not_found');

  var phones = extractPhones(src, opts.exclude_phones, anchorPos);
  if (!phones.length) warnings.push('phone_not_found');
  else if (phones[0].source === 'raw-html') warnings.push('phone_from_raw_html_fallback');
  else if (/telephone$/i.test(phones[0].source)) warnings.push('phone_from_generic_telephone_key');

  var advs = extractAdvertiser(src, phones.length ? phones[0].raw : null);
  if (!advs.length) warnings.push('advertiser_not_found');
  else if (advs[0].source === 'dom-near-phone') warnings.push('advertiser_from_dom_fallback');

  return {
    // the four deliverable fields — blank, never thrown, when not found
    advertiser_name: advs.length ? advs[0].name : '',
    price_eur: priceCands.length ? priceCands[0].value : '',
    phone: phones.length ? phones[0].phone : '',
    link: url,
    // diagnostics (not written to the Results tab)
    listing_id: targetId,
    price_source: priceCands.length ? priceCands[0].source : null,
    phone_source: phones.length ? phones[0].source : null,
    phone_raw: phones.length ? phones[0].raw : '',
    advertiser_source: advs.length ? advs[0].source : null,
    all_phones: phones.slice(0, 5),
    all_advertisers: advs.slice(0, 5),
    warnings: warnings
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    decodeEntities: decodeEntities, stripTags: stripTags, deepUnescape: deepUnescape, normalizeNumberToken: normalizeNumberToken,
    parsePriceEur: parsePriceEur, findPriceCandidates: findPriceCandidates, extractJsonLd: extractJsonLd,
    findListingLinks: findListingLinks, listingIdFromUrl: listingIdFromUrl, parseListPage: parseListPage,
    detectPaginationTemplate: detectPaginationTemplate, buildPageUrl: buildPageUrl, detectBlock: detectBlock,
    normalizePhone: normalizePhone, extractPhones: extractPhones, extractAdvertiser: extractAdvertiser,
    parseDetail: parseDetail, ZIDA_ORIGIN: ZIDA_ORIGIN,
    idOccurrences: idOccurrences, priceNearId: priceNearId, enclosingObjectSpan: enclosingObjectSpan, SITE_PHONES: SITE_PHONES,
    scrapingBeeUrl: scrapingBeeUrl, isFetchError: isFetchError, describeFetchError: describeFetchError
  };
}
