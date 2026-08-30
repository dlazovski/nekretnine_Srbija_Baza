# Assumptions about 4zida.rs HTML — spot-check list

**Status: Step 0 was run live on 2026-08-30** (11 requests, all HTTP 200, no
blocks). Items below are marked **CONFIRMED** where the probe settled them and
**ASSUMED** where it did not. Two assumptions failed and are documented at the
top; both are fixed, and both are now covered by regression tests.

Re-run `workflows/4zida-step0-probe.json` after any change to `src/lib/parse.js`
— it now also cross-checks each results-page price against the listing's own
page, which is what catches a mis-attributed price.

The column **If wrong** tells you what actually breaks, so you can judge which
of these are worth checking by hand before a full 5-category run.

---

## 0. What Step 0 found (2026-08-30)

### CONFIRMED (run 2, after the fixes)
* **Prices are correct.** All 10 detail probes matched their results-page price,
  across all five categories, with every price sourced from the exact JSON-LD
  pairing. The neighbour-theft bug is gone: `prodaja-kuca` now reads
  187000 / 345000 / 99000 where it previously read 187000 / **187000** / 345000.
* **Phones are per-listing.** 10 probes returned 10 distinct numbers, none
  shared across listings. The site switchboard no longer appears.
* **Advertiser names resolve for both kinds of poster** — private individuals
  ("Goran Stojanovic") and agencies ("Lav 2020 nekretnine") both via
  `fullName`, with `author` as the alternate.

### CONFIRMED (run 1)
* **Pagination is `?strana=N`** — detected via `rel="next"` on all five categories.
* **Out-of-range pages clamp** — `?strana=9999` returned HTTP 200 with 20 real
  listings, not an empty page. End-of-results must therefore be detected by
  repeated content, not by emptiness.
* **`render_js` is not needed.** The page displays `062 43****` masked, and the
  unmasked number is in the served HTML. Confirmed on all five categories.
* **No bot protection encountered.** Pages are ~0.9–1.2 MB, HTTP 200.
* **Prices are not in the visible HTML.** The DOM-text strategy found 0 prices in
  every category; prices live in JSON-LD (20 per page) and in the Next.js flight
  payload (all 20–26 per page). The DOM strategy is now a last resort only.
* **20–26 listings per results page**, varying by category. JSON-LD covers the
  first 20; the payload scan covers the rest.
* **Adjacent listings genuinely do share prices sometimes** (399000 twice among
  commercial units). Since JSON-LD pairs a url with its own price inside one
  object, a duplicate from that source is not evidence of mis-attribution, and
  the probe only raises it as an action when the price came from a heuristic
  scan instead.

### FAILED — found by the probe, fixed, regression-tested

**F1. Every row got 4zida's own switchboard as the phone number.**
All five categories returned `+381244155869`. Its context gives it away:
`"telephone":"+381244155869","email":"info@4zida.rs"`, a Subotica address,
`"foundingDate":"2015"` — the site's own Organization block, present on every
listing page. The advertiser's real number was sitting in the listing's own
`phones` array (`+381658236112`, `+381693422234`, …), distinct per listing.
Both sources ranked equally, so document order decided, and the Organization
block comes first.
*Fix:* `phones` now outranks the generic schema.org `telephone` key; any number
in a block mentioning 4zida is pushed to the bottom; the confirmed number is in
`SITE_PHONES` and excluded outright.

**F2. Listings were taking their neighbour's price.**
In four of five categories the first two listings shared a price
(70300/70300, 187000/187000, 1250000/1250000, 32000/32000). The fifth category
was the only one where the exact JSON-LD strategy won, and its prices were all
distinct. The cause: the payload scan searched a fixed ±1500-character window
around each listing id and took the first price it saw — which, in a payload of
packed listing objects, is the *previous* listing's price, shifting every
listing after the first.
*Fix:* the price now comes from inside the listing's **own JSON object**, found
by balanced-brace scanning, never from a proximity window. JSON-LD, being exact
by construction, is preferred where present, and the two strategies are now read
from independent sources so a disagreement between them is real evidence.
**This bug corrupted the 100k filter itself**, not just the Price column.

**F3. `"$7e"` was accepted as an advertiser name.** Next.js flight payloads
serialise references that way. Harmless here only because a real name outranked
it. *Fix:* `$`-prefixed and bare-hash strings are rejected as names.

**F4. The phone fell back to the loose raw-HTML regex on 8 of 10 listings**
(second probe run). Two causes, both visible in the captured `phone_context`:
the advertiser block arrives as JSON nested inside JSON
(`"authorData":"{\\"fullName\\":...}"`), so a single unescape pass left `\"`
in place and every `"key"` pattern missed it; and `phones` holds **objects**,
not strings — the number lives under `"full"` / `"national"`.
The fallback did return the right number every time, but only because it was the
first Serbian-looking number on the page: luck, not logic, and one unrelated
number earlier in the markup would have taken its place.
*Fix:* `deepUnescape()` flattens however many escaping levels are present
(idempotent, bounded), and `"full"`/`"national"` inside a phone object are
matched directly. Confirmed structure:
`"phones":[{"full":"+381693422234","isViber":false,"national":"069 3422234","regionCode":"RS","verified":true}]`

### Why the probe reported "None — all Step 0 assumptions held"
It checked whether a field was *found*, never whether the value was *right*.
The report now also cross-checks results-page price against detail-page price
for two listings per category, flags adjacent duplicate prices, flags a phone
that repeats across unrelated listings, flags a phone taken from the generic
`telephone` key, and flags disagreement between the two price strategies.

---

## A. Assumptions taken from the brief (stated as tested, so treated as given)

| # | Assumption | If wrong |
|---|---|---|
| A1 | Search/listing pages are server-rendered with real prices in the HTML. **CONFIRMED** — though in JSON payloads, not visible text. | Stage 1 finds no prices; everything is skipped as unpriced. Probe reports `price_coverage_pct: 0`. |
| A2 | Detail pages are server-rendered (not a JS shell). **CONFIRMED.** | Stage 2 returns blank fields for every listing. |
| A3 | The **full, unmasked** phone is in the raw HTML despite the masked display. **CONFIRMED on all 5 categories.** | `phone` is blank everywhere. Probe reports `render_js_needed_for_phone: true` — the fix is `render_js=true` on `Fetch Detail Page`, at ~10× the credit cost. |
| A4 | No minimum-price URL filter exists. | (Closed question — not re-checked. Its absence is *why* Stage 1 exists.) |
| A5 | The five category base URLs cover the full scope. | A category is silently missed. |

## B. Assumptions I made, that the brief did not settle

### B1 — Listing links end in a 24-character hex id  — **CONFIRMED**
Every listing URL is assumed to look like
`/prodaja-{kind}/{location}/{type}/{24-hex-id}`, e.g.
`…/trosoban-stan/6a91d04359e6b8eb78023435` (the one example in the brief).
The scraper finds listings by matching that shape rather than by CSS class, so
it survives styling changes and works identically in all five categories.

* **Where:** `LISTING_PATH_RE` in `src/lib/parse.js`.
* **Guards:** paths containing `_nuxt` or a file extension are rejected, so
  asset hashes can't be mistaken for listings.
* **Also the dedupe key** and the checkpoint's `Last Listing ID`.
* **If wrong:** zero listings found on every page. Probe: `listings_on_page_1: 0`.
* **Per-category risk:** low. The id shape is a database convention, unlikely
  to differ between apartments and garages — but the probe checks all five.

### B2 — Price association — **REWRITTEN after F2 above**
When neither JSON-LD nor an embedded JSON payload carries the price, the price
is read from the slice of HTML between one listing link and the next, falling
back to a 1,200-character look-behind for layouts that print the price above
the link.

* **Where:** `listFromDomSpans()`.
* **If wrong:** prices get attributed to the *neighbouring* listing — the
  quietest and most damaging possible failure, because rows still look
  plausible. **This is the one to eyeball first:** the probe prints
  `sample_listings` (id, url, price) for page 1 of each category; open two or
  three of those URLs and confirm the price matches.
* **Per-category risk:** medium. Card layouts can differ between, say, land and
  apartments.

### B3 — Price format is Serbian and per-m² figures must be excluded
`100.000 €` is 100,000 (dot = thousands separator); `99.500,50 €` is 99,500.50.
Any amount immediately followed by `/m²`, `m2` or `po m` is a price-per-square-
metre and is **never** taken as the listing price.

* **Where:** `normalizeNumberToken()`, `isPerSquareMetre()`.
* **If wrong:** without the per-m² guard, a `2.500 €/m²` figure would read as
  2,500 and every listing would fall below the threshold — the category would
  silently return nothing.
* Currencies other than EUR in JSON-LD are discarded rather than converted.

### B4 — "Cena na upit" means skip, not fail
A listing with no numeric price is skipped at Stage 1, counted in
`stage1_skipped_no_price`, and its detail page is never fetched.

* **Consequence to accept:** if a listing hides a >100k price behind "price on
  request", it will be missed. That follows directly from the brief ("do not
  guess a price").

### B5 — Pagination pattern is discoverable from page 1 — **CONFIRMED (`?strana=N`)**
Read from `<link rel="next">`, else from any pagination anchor pointing at the
same category path; supports `?strana=N`, `?page=N`, `?p=N`, `/stranica/N`,
`/strana/N`, `/page/N`. Falls back to `?strana=N` only if nothing is found.

* **Where:** `detectPaginationTemplate()`.
* **If wrong (fallback used and also wrong):** the site keeps serving page 1;
  the run stops early on the repeated-ids check rather than looping forever.
  Check `Run Summary.pagination_style` — it says exactly what was used.

### B6 — End of results looks like an empty page *or* a repeated page — **CONFIRMED: 4zida clamps**
Both are handled: zero listings found, or a page whose ids exactly repeat the
previous page's (sites that clamp out-of-range pages to the last real one).

* Because `?strana=9999` returns a real page, every page's id-signature is
  remembered for the run. A clamp back to page 1 — not just to the previous
  page — ends pagination. The hard 5,000-page cap remains as a backstop.

### B7 — The phone sits in a phone-specific key — **CONFIRMED (`phones` array), after F1**
Tried in this order: JSON keys (`phone`, `phoneNumber`, `telefon`, `mobile`,
`contactPhone`, …) → `tel:` hrefs and `data-phone`-style attributes →
`itemprop="telephone"` → a loose Serbian-number regex over the raw HTML.

* **Where:** `extractPhones()`. **The brief explicitly left this unlocated —
  it is the single most likely thing to need adjusting.**
* Numbers found inside `<header>`, `<footer>` or `<nav>` are demoted to last,
  so 4zida's own support number doesn't win. Belt and braces: put it in
  `Config.exclude_phones`.
* Accepted forms: `06x xxx xxxx`, `+381 6x …`, `00381 …`, `062/431-234`,
  landlines `011…`/`021…`. Output is normalised to national form with no
  separators (e.g. `0624312345`) so the column is consistent.
* **If wrong:** the probe prints `phone_source`, every candidate it found, and
  `phone_context` — 340 characters of the surrounding raw HTML. That is enough
  to write the correct key/selector into `extractPhones()`.
* **Agency vs. private:** the brief flags that agency listings may differ, and
  that some listings carry several numbers. Only the highest-ranked candidate
  is written; the rest appear in the execution data as `all_phones`.

### B8 — The advertiser name is in a name-ish JSON key — **CONFIRMED (`fullName`, `author`, jsonld `Person`)**
Tried: hydration keys (`advertiserName`, `agencyName`, `companyName`, `seller`,
`owner`, `contactName`, `oglasivac`, `agencija`, …) → JSON-LD
`seller`/`provider`/`author`/`agent` or a `RealEstateAgent`/`Person` object →
last resort, the nearest short text line above the phone number in the DOM.

* **Where:** `NAME_KEYS`, `extractAdvertiser()`.
* Names containing "4zida" are rejected so the site itself is never written as
  the advertiser.
* **The same selector is assumed to serve both** a private individual's
  personal name and an agency's company name — that is exactly what the brief
  asked to verify. The probe reports `advertiser_source` and
  `looks_like_agency_listing` per category.
* **If wrong:** name blank, or the DOM fallback fires (flagged as
  `advertiser_from_dom_fallback` in the row's warnings). The fallback is the
  weakest link here — treat any row sourced from it as suspect.

### B9 — Blocked ≠ empty
A response counts as blocked on: a ScrapingBee JSON error body (bad key, no
credits), HTTP 401/403/429, a challenge/CAPTCHA marker in the body
(Cloudflare "Just a moment", reCAPTCHA, "access denied", "too many requests",
…), or an HTTP 200 under 2 KB with no `4zida` marker. **Anything else with zero
listings is a parse failure, not a block** — it stops the pagination loop
cleanly instead of raising a false alarm.

* **Where:** `detectBlock()`, `BLOCK_MARKERS`.
* **If wrong in the strict direction** (a real block not recognised): the run
  ends early with `end_of_results:empty_page_N` on a low page number. If a
  category stops after two or three pages, suspect this.
* **If wrong in the loose direction** (a real page called a block): the run
  hard-stops with the matched marker printed in the error, so it's obvious.
* The `< 2 KB` stub rule assumes real 4zida pages are always larger than that.

### B10 — Google Sheets tabs and headers exist as documented
`Results`, `Errors`, `Checkpoint` with the exact header rows in the README.
Columns are matched by header name; the `Checkpoint` tab is upserted on
`Category`, so it holds one live row per category rather than growing.

### B11 — Detail-page price wins over list-page price
If the two disagree the detail value is written and the discrepancy is recorded
in `price_mismatch` in the execution data. The row is not failed. Frequent
mismatches would mean the Stage 1 card slicing (B2) is misattributing prices.

### B12 — ScrapingBee parameter combinations
`country_code` is sent **only** when `premium_proxy` is on, because ScrapingBee
rejects the pair otherwise with HTTP 400 — which fails every request in the run.
Optional parameters are omitted entirely rather than sent empty. The endpoint
URL is built by `scrapingBeeUrl()` in `src/lib/parse.js`; the API key is
appended by the n8n credential and never appears in the URL the workflow builds.

### B13 — Static data survives the execution
Loop state and counters live in `$getWorkflowStaticData('global')`, reset at the
start of every run by `Init Pager`. Durable progress goes to the `Checkpoint`
tab in Google Sheets, not to static data — so resumability doesn't depend on
n8n's static-data persistence rules.
