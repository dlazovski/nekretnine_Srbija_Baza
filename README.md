# 4zida.rs → Google Sheets — listings above 100,000 EUR (all of Serbia)

A one-time (manually triggered) n8n workflow that pages through a 4zida.rs
for-sale category across all of Serbia, keeps only listings priced **above
100,000 EUR**, and appends four fields per listing to Google Sheets:
**Advertiser Name, Price (EUR), Phone, Link** (plus a `Category` column so rows
from different runs stay traceable).

```
workflows/4zida-step0-probe.json     ← run this FIRST (~11 ScrapingBee credits)
workflows/4zida-serbia-scraper.json  ← the scraper
```

---

## ⚠️ Read this before you run anything

**Step 0 has been run live (2026-08-30) and found two bugs that would have
silently corrupted the output.** Both are fixed; see
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) §0 for the evidence.

* Every row was getting **4zida's own switchboard** (`+381244155869`) instead of
  the advertiser's number.
* Listings were taking their **neighbour's price**, which corrupted the 100k
  filter itself, not just the Price column.

Pagination (`?strana=N`), `render_js=false`, and the absence of bot protection
are now **confirmed** on all five categories.

**Re-run the probe before the first real scrape** to confirm the fixes on live
pages — it now cross-checks each results-page price against the listing's own
page, which is the check that catches a mis-attributed price:

1. Import `workflows/4zida-step0-probe.json`, add your ScrapingBee credential,
   run it (~16 credits). It fetches page 1 of all five categories, **two** detail
   pages per category, and one deliberately out-of-range page, then prints a
   structured report.
2. Read `actions_required` at the top of the report. Every line names a concrete
   thing to change and the function in `src/lib/parse.js` to change it in. An
   empty list means all assumptions held and the scraper is good to go.
3. Fix anything flagged, re-run `python3 build/build.py`, re-import.

The extractors are deliberately **multi-strategy**: each field is attempted via
JSON-LD, then the embedded payload, then a raw-HTML regex, and every row records
which strategy won (`price_source`, `phone_source`, `advertiser_source` appear
in the run's execution data). Prices additionally come from two *independent*
sources, and a disagreement between them is reported rather than resolved
silently.

Verified by 181 assertions, including regression tests reproducing both live
bugs from the payload shapes the probe reported. See
[Development](#development).

---

## Setup (once)

**1. ScrapingBee credential.** In n8n: *Credentials → New → Query Auth*.
Name it `ScrapingBee API key (query auth)`, set **Name** = `api_key` and
**Value** = your key. Both HTTP Request nodes in each workflow reference it.

**2. Google Sheets credential.** A normal *Google Sheets OAuth2* credential.

**3. The spreadsheet.** Create one sheet with three tabs and these exact header
rows:

| Tab | Header row |
|---|---|
| `Results` | `Advertiser Name` · `Price (EUR)` · `Phone` · `Link` · `Category` |
| `Errors` | `Link` · `Error message` · `Category` |
| `Checkpoint` | `Category` · `Last Page` · `Last Listing ID` · `Listings Scanned` · `Passed Filter` · `Written` · `Errors` · `Status` · `Updated At` |

**4. Config node.** Open `Config` and set `spreadsheet_id` to the id from your
sheet's URL (`docs.google.com/spreadsheets/d/`**`<this bit>`**`/edit`).

---

## Running a category

> **The only field you change between runs is `category_base_url` in the
> `Config` node.** Everything else — the category label written to the sheet,
> the pagination URLs, the checkpoint row — is derived from it.

| Category | `category_base_url` |
|---|---|
| Apartments | `https://www.4zida.rs/prodaja-stanova` |
| Houses | `https://www.4zida.rs/prodaja-kuca` |
| Commercial | `https://www.4zida.rs/prodaja-poslovnih-prostora` |
| Land | `https://www.4zida.rs/prodaja-placeva` |
| Garages / parking | `https://www.4zida.rs/prodaja-garaza-i-parkinga` |

Set it, click **Execute Workflow**, wait. Repeat for the next category.

Garages returning **zero** rows is the expected outcome, not a bug — a garage
above 100,000 EUR barely exists. The `Run Summary` node will still show a
healthy `stage1_listings_scanned` with everything filtered out at Stage 1.

### The rest of the Config node

| Field | Default | What it does |
|---|---|---|
| `min_price_eur` | `100000` | Strictly-greater-than threshold. |
| `spreadsheet_id` | — | Your Google Sheet id. |
| `results_tab` / `errors_tab` / `checkpoint_tab` | `Results` / `Errors` / `Checkpoint` | Tab names. |
| `delay_seconds` | `2.5` | Politeness pause before every detail request. |
| `checkpoint_every` | `25` | Write a checkpoint every N successful rows. |
| `checkpoint_every_pages` | `25` | Write a checkpoint every N results pages, so a run interrupted during pagination is also resumable. |
| `max_pages` | `0` | `0` = unlimited. Set to `2` for a cheap smoke test. |
| `resume_from_page` | `1` | See [Resuming](#resuming-an-interrupted-run). |
| `resume_after_listing_id` | *(blank)* | See [Resuming](#resuming-an-interrupted-run). |
| `exclude_phones` | *(blank)* | Comma-separated numbers to never treat as an advertiser's — put 4zida's own support number here if the probe shows it being picked up. |
| `premium_proxy` | `false` | Flip to `true` if you get blocked. Costs more credits. |
| `country_code` | `rs` | ScrapingBee exit country. **Only sent when `premium_proxy` is `true`** — ScrapingBee rejects the request outright if a country is requested without a premium proxy, so the workflow omits it rather than sending an invalid pair. |

---

## What each node does

**Stage 1 — pagination and the cheap price filter**

| Node | Role |
|---|---|
| `Run Manually` | Manual trigger. One-time run by design; nothing is scheduled. |
| `Config` | The only node you edit. |
| `Init Pager` | Validates `category_base_url`, derives the category label, resets the run accumulator in workflow static data, emits the page-1 URL. Loop state lives in static data so items stay tiny — 34,000 listings never ride inside an n8n item. |
| `Fetch List Page` | ScrapingBee GET, `render_js=false`. 3 retries, 5s apart; a final failure continues as an error item rather than killing the run. |
| `Parse List Page` | **Stage 1.** Detects the real pagination pattern from page 1 (see below), parses every listing's link + price, drops everything at or below the threshold, accumulates only the survivors, and decides whether to loop again. |
| `Blocked?` → `STOP - Bot Block Detected` | A bot-check/CAPTCHA/credit failure stops the run immediately with a readable message, so credits aren't burned against a blocked target. This is deliberately distinct from "parsed nothing". |
| `More Pages?` | Loops back to `Fetch List Page` until an end-of-results signal, `max_pages`, or a hard 5,000-page cap. |

**Stage 2 — detail pages, only for listings that already passed**

| Node | Role |
|---|---|
| `Stage 1 Filter and Dedupe` | Re-applies the threshold authoritatively, de-dupes by listing id (the 24-hex final path segment), applies `resume_after_listing_id`, and emits one item per listing. |
| `Any Listings Above 100k?` | Zero qualifiers routes straight to the summary instead of dead-ending. |
| `Loop Over Listings` | Split In Batches, one link at a time. |
| `Wait 2-3s` | `delay_seconds` pause before each request. |
| `Fetch Detail Page` | ScrapingBee GET, `render_js=false` — the unmasked phone is in the server-rendered HTML, so JS rendering would only cost ~10× the credits. Same retry policy. |
| `Extract 4 Fields` | Extracts advertiser name, price, phone, link. Missing fields are left **blank**, never thrown. Re-parses the price as a sanity check against Stage 1 and records any mismatch. |
| `Detail Blocked?` → `STOP` | Same hard stop as Stage 1. |
| `Extracted OK?` | Routes good rows to `Results`, failed fetches to `Errors`. |
| `Append to Results` → `Count Written` | Appends the row, then counts it — so the summary reports rows *actually in the sheet*. |
| `Checkpoint Due?` → `Build Checkpoint Row` → `Write Checkpoint` | Every `checkpoint_every` rows, upserts the one row for this category in the `Checkpoint` tab. |
| `Append to Errors` → `Count Error` | Logs `Link`, `Error message`, `Category` and carries on. One bad listing never takes down the category. |
| `Build Summary` → `Write Final Checkpoint` → `Run Summary` | End-of-run tally, and marks the checkpoint `COMPLETED` (or `STOPPED: <reason>`). |

### Pagination is detected, not guessed

The brief did not settle whether pages are `?page=N`, `?strana=N`, or
`/stranica/N`. Rather than hard-code one, `Parse List Page` reads the pattern
off page 1 — `<link rel="next">` first, then any pagination anchor pointing at
the same category path — and reports what it found in
`Run Summary.pagination_style`. Only if nothing at all is found does it fall
back to `?strana=N`, and the summary says so loudly.

End of results is detected two ways, because both shapes exist in the wild: a
page with zero listings, **or** a page whose listing ids repeat the previous
page (sites that clamp an out-of-range page back to the last real one).

---

## Resuming an interrupted run

**One-liner:** open the `Checkpoint` tab, copy that category's `Last Page` into
`Config.resume_from_page` and its `Last Listing ID` into
`Config.resume_after_listing_id`, and run again.

The run re-fetches page 1 once (that is where the pagination pattern is read
from), jumps straight to `resume_from_page`, and skips every queued listing up
to and including `resume_after_listing_id`. If that id isn't in the new queue
the run proceeds anyway and flags `resume_warning` in the summary rather than
silently skipping nothing.

---

## Assumptions to spot-check

Every assumption about the site's HTML, per category, with how to verify it and
what happens if it's wrong, is listed in **[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)**.
The Step 0 probe checks all of them automatically.

---

## Scale: what a full category actually costs

Measured from the probe: ~26 listings per results page, ~2 s per ScrapingBee
request, and the `delay_seconds` pause applies to detail requests only.
Apartments (34,128 listings) works out at ~1,313 results pages (~45 min), plus
one detail request per listing above 100,000 EUR:

| Share above 100k | Detail requests | Total requests | Detail phase |
|---|---|---|---|
| 20% | ~6,800 | ~8,100 | ~8.5 h |
| 30% | ~10,200 | ~11,600 | ~13 h |
| 40% | ~13,700 | ~15,000 | ~17 h |

That is one long n8n execution. **Run it in chunks**: set `max_pages` to 200
(~7 chunks of roughly 2 h for apartments), and between chunks copy `Last Page`
from the `Checkpoint` tab into `resume_from_page`. The other four categories are
far smaller, and garages should yield ~0 rows.

Two consequences of a multi-hour run worth knowing: listings shift between pages
as new ones are posted, so a few may be missed or seen twice (duplicates are
dropped by listing id, misses are not recoverable without a re-run); and the
`Checkpoint` tab is what tells you where to resume, not arithmetic on
`max_pages`.

---

## Reading the run summary

Two fields worth checking after every run:

* `stage1_rejected_not_a_listing_url` — links whose shape is not
  `/{category}/{location}/{type}/{id}`. These resolve to search pages, so they
  are dropped before costing a detail request. A handful per page is normal;
  `rejected_url_samples` shows what they were.
* `errors_no_advertiser_block` — detail pages that returned neither a name nor a
  phone. These go to the `Errors` tab with their link rather than to `Results`
  as a price with no contact. A non-zero count means some link shape is still
  slipping through — send the links in that tab.

## If requests fail

The probe report leads with a verdict. If it says **`EVERY REQUEST FAILED`**,
nothing in the rest of that report says anything about the site — the
`actions_required` lines will quote ScrapingBee's actual complaint. The usual
causes, in order:

1. **Credential missing or misnamed.** It must be a *Query Auth* credential
   with **Name** exactly `api_key`. A wrong name gives HTTP 401.
2. **Out of credits.** ScrapingBee returns a JSON error body; the report quotes it.
3. **`country_code` without `premium_proxy`.** An invalid pair that ScrapingBee
   rejects with HTTP 400. The workflow no longer constructs it, but if you set
   the params by hand, keep them consistent.

The same applies mid-run in the scraper: a failed list-page fetch stops
pagination with `list_fetch_failed_page_N` and the upstream error text in
`Run Summary.stop_reason`, rather than looking like a clean end of results.

---

## Development

The parsing library lives in one file and is injected into every Code node at
build time — fix a selector once, rebuild, never hand-edit the JSON.

```
src/lib/parse.js     all parsing/extraction logic (single source of truth)
src/nodes/*.js       per-node logic; the library is prepended at build time
build/build.py       assembles workflows/*.json
tests/               unit tests, structural validation, workflow simulation
```

```bash
python3 build/build.py   # regenerate both workflow JSON files
npm test                 # 181 assertions across 4 suites
```

`tests/simulate.js` is the important one: it pulls the JavaScript **out of the
built workflow JSON** and runs it against fixture pages with n8n's runtime
globals mocked, covering the happy path, agency vs. private advertisers, blank
fields, per-listing fetch errors, bot-block detection, both end-of-results
shapes, `max_pages`, resume, and the zero-qualifier (garages) case.
