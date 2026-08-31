#!/usr/bin/env python3
"""Assembles the importable n8n workflow JSON from src/lib + src/nodes.

The parsing library is a single source of truth that gets prepended into every
Code node, so a selector fix is made once in src/lib/parse.js and rebuilt --
never hand-edited in nine places inside the JSON.
    python3 build/build.py
"""
import io, json, os, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = io.open(os.path.join(ROOT, 'src/lib/parse.js'), encoding='utf-8').read()
BANNER = ("/* ---------------------------------------------------------------\n"
          " * Shared 4zida parsing library - GENERATED, DO NOT EDIT HERE.\n"
          " * Edit src/lib/parse.js and re-run: python3 build/build.py\n"
          " * --------------------------------------------------------------- */\n")

def js(name):
    body = io.open(os.path.join(ROOT, 'src/nodes', name), encoding='utf-8').read()
    return BANNER + LIB + "\n/* ------------------------- node logic ------------------------- */\n" + body

def uid(seed):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'n8n-4zida/' + seed))

def node(name, ntype, tv, pos, params, **kw):
    n = {"parameters": params, "id": uid(name), "name": name, "type": ntype,
         "typeVersion": tv, "position": pos}
    n.update(kw)
    return n

def code(name, pos, script):
    return node(name, "n8n-nodes-base.code", 2, pos, {"jsCode": js(script)})

def setnode(name, pos, fields):
    return node(name, "n8n-nodes-base.set", 3.4, pos, {
        "assignments": {"assignments": [
            {"id": uid(name + f["name"]), "name": f["name"], "value": f["value"], "type": f.get("type", "string")}
            for f in fields]},
        "includeOtherFields": False, "options": {}})

def cond(left, op_type, op, right=None, single=False):
    o = {"type": op_type, "operation": op}
    if single:
        o["singleValue"] = True
    c = {"id": uid(left + op), "leftValue": left, "rightValue": right if right is not None else "", "operator": o}
    return c

def ifnode(name, pos, conditions):
    return node(name, "n8n-nodes-base.if", 2.2, pos, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": conditions, "combinator": "and"},
        "looseTypeValidation": True, "options": {}})

def scrapingbee(name, pos, url_expr, notes):
    """ScrapingBee GET. The whole endpoint URL is built in code (scrapingBeeUrl)
    so optional params are omitted rather than sent empty -- ScrapingBee rejects
    country_code unless a premium proxy is on. The credential appends api_key.
    render_js stays false: the unmasked phone is in the server-rendered HTML, so
    JS rendering would only cost ~10x the credits."""
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "url": url_expr,
        "authentication": "genericCredentialType",
        "genericAuthType": "httpQueryAuth",
        "sendQuery": False,
        "options": {"response": {"response": {"fullResponse": True, "responseFormat": "text"}},
                    "timeout": 120000}},
        credentials={"httpQueryAuth": {"id": "REPLACE_WITH_YOUR_CREDENTIAL", "name": "ScrapingBee API key (query auth)"}},
        retryOnFail=True, maxTries=3, waitBetweenTries=5000,
        onError="continueRegularOutput", notes=notes, alwaysOutputData=True)

def sheet(name, pos, tab_expr, cols, operation="append", match=None, notes=""):
    schema = [{"id": c, "displayName": c, "required": False, "defaultMatch": False,
               "display": True, "type": "string", "canBeUsedToMatch": True} for c in cols]
    params = {
        "resource": "sheet",
        "operation": operation,
        "documentId": {"__rl": True, "value": "={{ $('Config').first().json.spreadsheet_id }}", "mode": "id"},
        "sheetName": {"__rl": True, "value": tab_expr, "mode": "name"},
        "columns": {"mappingMode": "defineBelow", "value": cols,
                    "matchingColumns": match or [], "schema": schema},
        "options": {"cellFormat": "USER_ENTERED"}}
    return node(name, "n8n-nodes-base.googleSheets", 4.5, pos, params,
                credentials={"googleSheetsOAuth2Api": {"id": "REPLACE_WITH_YOUR_CREDENTIAL",
                                                       "name": "Google Sheets account"}},
                retryOnFail=True, maxTries=3, waitBetweenTries=5000, notes=notes)

def conn(pairs):
    out = {}
    for src, idx, dst, didx in pairs:
        out.setdefault(src, {"main": []})
        while len(out[src]["main"]) <= idx:
            out[src]["main"].append([])
        out[src]["main"][idx].append({"node": dst, "type": "main", "index": didx})
    return out

def write(path, wf):
    p = os.path.join(ROOT, path)
    io.open(p, 'w', encoding='utf-8').write(json.dumps(wf, indent=2, ensure_ascii=False) + "\n")
    print("wrote %-52s %6.1f KB  %2d nodes" % (path, os.path.getsize(p) / 1024.0, len(wf["nodes"])))


# ============================================================================
# MAIN WORKFLOW
# ============================================================================
CONFIG_FIELDS = [
    # >>> THE ONLY FIELD YOU CHANGE BETWEEN RUNS <<<
    {"name": "category_base_url", "value": "https://www.4zida.rs/prodaja-stanova"},
    {"name": "min_price_eur", "value": 100000, "type": "number"},
    {"name": "spreadsheet_id", "value": "PUT_YOUR_GOOGLE_SHEET_ID_HERE"},
    {"name": "results_tab", "value": "Results"},
    {"name": "errors_tab", "value": "Errors"},
    {"name": "checkpoint_tab", "value": "Checkpoint"},
    {"name": "delay_seconds", "value": 2.5, "type": "number"},
    {"name": "checkpoint_every", "value": 25, "type": "number"},
    {"name": "checkpoint_every_pages", "value": 25, "type": "number"},
    {"name": "max_pages", "value": 0, "type": "number"},
    {"name": "resume_from_page", "value": 1, "type": "number"},
    {"name": "resume_after_listing_id", "value": ""},
    {"name": "exclude_phones", "value": ""},
    {"name": "premium_proxy", "value": "false"},
    {"name": "country_code", "value": "rs"},
]

RESULT_COLS = {
    "Advertiser Name": "={{ $json.advertiser_name }}",
    "Price (EUR)": "={{ $json.price_eur }}",
    "Phone": "={{ $json.phone }}",
    "Link": "={{ $json.link }}",
    "Category": "={{ $json.category }}",
}
ERROR_COLS = {
    "Link": "={{ $json.link }}",
    "Error message": "={{ $json.error_message }}",
    "Category": "={{ $json.category }}",
}
CHECKPOINT_COLS = {
    "Category": "={{ $json.category }}",
    "Last Page": "={{ $json.last_page }}",
    "Last Listing ID": "={{ $json.last_listing_id }}",
    "Listings Scanned": "={{ $json.listings_scanned }}",
    "Passed Filter": "={{ $json.passed_filter }}",
    "Written": "={{ $json.written }}",
    "Errors": "={{ $json.errors }}",
    "Status": "={{ $json.status }}",
    "Updated At": "={{ $json.updated_at }}",
}
FINAL_CHECKPOINT_COLS = dict(CHECKPOINT_COLS)
FINAL_CHECKPOINT_COLS.update({
    "Last Page": "={{ $json.last_completed_page }}",
    "Listings Scanned": "={{ $json.stage1_listings_scanned }}",
    "Passed Filter": "={{ $json.stage1_passed_price_filter }}",
    "Written": "={{ $json.written_to_sheet }}",
    "Errors": "={{ $json.errors_logged }}",
    "Last Listing ID": "={{ $json.last_written_id }}",
    "Status": "={{ $json.stop_reason === 'completed' ? 'COMPLETED' : 'STOPPED: ' + $json.stop_reason }}",
    "Updated At": "={{ $json.finished_at }}",
})

main_nodes = [
    node("Run Manually", "n8n-nodes-base.manualTrigger", 1, [-260, 300], {},
         notes="One-time run. Not scheduled by design."),
    setnode("Config", [-60, 300], CONFIG_FIELDS),
    code("Init Pager", [140, 300], "init_pager.js"),
    scrapingbee("Fetch List Page", [340, 300], "={{ $json.sb_url }}",
                "Stage 1 source. Retries 3x/5s; a final failure continues as an error item."),
    code("Parse List Page", [540, 300], "parse_list_page.js"),
    ifnode("Blocked?", [740, 300], [cond("={{ $json.blocked }}", "boolean", "true", single=True)]),
    node("STOP - Bot Block Detected", "n8n-nodes-base.stopAndError", 1, [940, 160],
         {"errorMessage": "=BLOCKED by 4zida/ScrapingBee while paging {{ $json.category }} at page {{ $json.page }}. Reason: {{ $json.block_reason }} - {{ $json.block_detail }}. Run stopped so no further credits are burned against a blocked target. Try premium_proxy=true in Config, wait, then resume from the page in the Checkpoint tab."},
         notes="Deliberate hard stop: a block is not a parse failure."),
    ifnode("More Pages?", [940, 420], [cond("={{ $json.done }}", "boolean", "false", single=True)]),
    ifnode("Page Checkpoint Due?", [740, 560],
           [cond("={{ $json.page % $('Config').first().json.checkpoint_every_pages }}", "number", "equals", 0)]),
    code("Build Page Checkpoint Row", [540, 640], "checkpoint.js"),
    sheet("Write Page Checkpoint", [340, 640], "={{ $('Config').first().json.checkpoint_tab }}",
          CHECKPOINT_COLS, operation="appendOrUpdate", match=["Category"],
          notes="Terminating side branch. NEVER put this on the loop-back path: a Sheets node replaces the item json, so the next Fetch List Page would get no sb_url."),
    code("Stage 1 Filter and Dedupe", [1140, 480], "stage1_filter.js"),
    ifnode("Any Listings Above 100k?", [1340, 480],
           [cond("={{ $json._no_listings }}", "boolean", "false", single=True)]),
    node("Loop Over Listings", "n8n-nodes-base.splitInBatches", 3, [1560, 560],
         {"batchSize": 1, "options": {"reset": False}},
         notes="Output 0 = done (summary), output 1 = one listing at a time."),
    node("Wait 2-3s", "n8n-nodes-base.wait", 1.1, [1780, 660],
         {"amount": "={{ $('Config').first().json.delay_seconds }}", "unit": "seconds"},
         webhookId=uid("waitwebhook"), notes="Politeness delay before every detail request."),
    scrapingbee("Fetch Detail Page", [1980, 660], "={{ $('Loop Over Listings').first().json.sb_url }}",
                "Stage 2. Only reached for listings already priced above the threshold."),
    code("Extract 4 Fields", [2180, 660], "extract_detail.js"),
    ifnode("Detail Blocked?", [2380, 660], [cond("={{ $json.blocked }}", "boolean", "true", single=True)]),
    node("STOP - Bot Block Detected (Detail)", "n8n-nodes-base.stopAndError", 1, [2580, 520],
         {"errorMessage": "=BLOCKED by 4zida/ScrapingBee on detail page {{ $json.link }}. Reason: {{ $json.block_reason }} - {{ $json.block_detail }}. Run stopped. Resume from the Checkpoint tab once unblocked."}),
    ifnode("Extracted OK?", [2580, 760],
           [cond("={{ $json.status }}", "string", "equals", "ok")]),
    sheet("Append to Results", [2800, 700], "={{ $('Config').first().json.results_tab }}", RESULT_COLS,
          notes="Exactly the 4 requested fields + Category for traceability."),
    code("Count Written", [3000, 700], "count_written.js"),
    ifnode("Checkpoint Due?", [3200, 700],
           [cond("={{ $json.written_count % $('Config').first().json.checkpoint_every }}", "number", "equals", 0)]),
    code("Build Checkpoint Row", [3400, 620], "checkpoint.js"),
    sheet("Write Checkpoint", [3600, 620], "={{ $('Config').first().json.checkpoint_tab }}",
          CHECKPOINT_COLS, operation="appendOrUpdate", match=["Category"],
          notes="One row per category, overwritten in place."),
    sheet("Append to Errors", [2800, 900], "={{ $('Config').first().json.errors_tab }}", ERROR_COLS,
          notes="Non-block failures land here and the run continues."),
    code("Count Error", [3000, 900], "count_error.js"),
    code("Build Summary", [1780, 400], "build_summary.js"),
    sheet("Write Final Checkpoint", [1980, 400], "={{ $('Config').first().json.checkpoint_tab }}",
          FINAL_CHECKPOINT_COLS, operation="appendOrUpdate", match=["Category"]),
    node("Run Summary", "n8n-nodes-base.noOp", 1, [2180, 400], {},
         notes="Open this node's output for the end-of-run tally."),
]

main_conns = conn([
    ("Run Manually", 0, "Config", 0),
    ("Config", 0, "Init Pager", 0),
    ("Init Pager", 0, "Fetch List Page", 0),
    ("Fetch List Page", 0, "Parse List Page", 0),
    ("Parse List Page", 0, "Blocked?", 0),
    ("Blocked?", 0, "STOP - Bot Block Detected", 0),
    ("Blocked?", 1, "More Pages?", 0),
    ("More Pages?", 0, "Fetch List Page", 0),
    ("Parse List Page", 0, "Page Checkpoint Due?", 0),
    ("Page Checkpoint Due?", 0, "Build Page Checkpoint Row", 0),
    ("Build Page Checkpoint Row", 0, "Write Page Checkpoint", 0),
    ("More Pages?", 1, "Stage 1 Filter and Dedupe", 0),
    ("Stage 1 Filter and Dedupe", 0, "Any Listings Above 100k?", 0),
    ("Any Listings Above 100k?", 0, "Loop Over Listings", 0),
    ("Any Listings Above 100k?", 1, "Build Summary", 0),
    ("Loop Over Listings", 0, "Build Summary", 0),
    ("Loop Over Listings", 1, "Wait 2-3s", 0),
    ("Wait 2-3s", 0, "Fetch Detail Page", 0),
    ("Fetch Detail Page", 0, "Extract 4 Fields", 0),
    ("Extract 4 Fields", 0, "Detail Blocked?", 0),
    ("Detail Blocked?", 0, "STOP - Bot Block Detected (Detail)", 0),
    ("Detail Blocked?", 1, "Extracted OK?", 0),
    ("Extracted OK?", 0, "Append to Results", 0),
    ("Extracted OK?", 1, "Append to Errors", 0),
    ("Append to Results", 0, "Count Written", 0),
    ("Count Written", 0, "Checkpoint Due?", 0),
    ("Checkpoint Due?", 0, "Build Checkpoint Row", 0),
    ("Build Checkpoint Row", 0, "Write Checkpoint", 0),
    ("Checkpoint Due?", 1, "Loop Over Listings", 0),
    ("Write Checkpoint", 0, "Loop Over Listings", 0),
    ("Append to Errors", 0, "Count Error", 0),
    ("Count Error", 0, "Loop Over Listings", 0),
    ("Build Summary", 0, "Write Final Checkpoint", 0),
    ("Build Summary", 0, "Run Summary", 0),
])

write("workflows/4zida-serbia-scraper.json", {
    "name": "4zida.rs Serbia - listings above 100k EUR",
    "nodes": main_nodes,
    "connections": main_conns,
    "settings": {"executionOrder": "v1", "saveManualExecutions": True,
                 "saveDataSuccessExecution": "all", "saveDataErrorExecution": "all"},
    "pinData": {}, "active": False, "tags": [],
})


# ============================================================================
# STEP 0 PROBE WORKFLOW
# ============================================================================
PROBE_CONFIG = [
    {"name": "categories",
     "value": "prodaja-stanova,prodaja-kuca,prodaja-poslovnih-prostora,prodaja-placeva,prodaja-garaza-i-parkinga"},
    {"name": "far_page", "value": 9999, "type": "number"},
    {"name": "delay_seconds", "value": 3, "type": "number"},
    {"name": "exclude_phones", "value": ""},
    {"name": "premium_proxy", "value": "false"},
    {"name": "country_code", "value": "rs"},
]

probe_sb = scrapingbee

probe_nodes = [
    node("Run Step 0 Probe", "n8n-nodes-base.manualTrigger", 1, [-260, 300], {},
         notes="Run this BEFORE the scraper. Costs ~11 ScrapingBee credits."),
    setnode("Probe Config", [-60, 300], PROBE_CONFIG),
    code("Build Probe Targets", [140, 300], "probe_targets.js"),
    node("Loop Probe A", "n8n-nodes-base.splitInBatches", 3, [340, 300],
         {"batchSize": 1, "options": {"reset": False}}, notes="One list page at a time."),
    node("Wait A", "n8n-nodes-base.wait", 1.1, [540, 420],
         {"amount": "={{ $('Probe Config').first().json.delay_seconds }}", "unit": "seconds"},
         webhookId=uid("waitA")),
    probe_sb("Fetch List Page (Probe)", [740, 420], "={{ $('Loop Probe A').first().json.sb_url }}",
             "Plain GET, no render_js - the Step 0 assumption under test."),
    code("Analyze List Probe", [940, 420], "probe_analyze_list.js"),
    code("Build Detail Probe Targets", [540, 180], "probe_detail_targets.js"),
    ifnode("Any Listings To Probe?", [640, 180],
           [cond("={{ $json._none }}", "boolean", "false", single=True)]),
    node("Loop Probe B", "n8n-nodes-base.splitInBatches", 3, [840, 180],
         {"batchSize": 1, "options": {"reset": False}}, notes="One detail page per category."),
    node("Wait B", "n8n-nodes-base.wait", 1.1, [940, 60],
         {"amount": "={{ $('Probe Config').first().json.delay_seconds }}", "unit": "seconds"},
         webhookId=uid("waitB")),
    probe_sb("Fetch Detail Page (Probe)", [1140, 60], "={{ $('Loop Probe B').first().json.sb_url }}",
             "Locates the unmasked phone and the advertiser name in the raw HTML."),
    code("Analyze Detail Probe", [1340, 60], "probe_analyze_detail.js"),
    code("Build Step 0 Report", [1140, 300], "probe_report.js"),
    node("STEP 0 REPORT", "n8n-nodes-base.noOp", 1, [1340, 300], {},
         notes="Open this node's output. Read actions_required first."),
]

probe_conns = conn([
    ("Run Step 0 Probe", 0, "Probe Config", 0),
    ("Probe Config", 0, "Build Probe Targets", 0),
    ("Build Probe Targets", 0, "Loop Probe A", 0),
    ("Loop Probe A", 0, "Build Detail Probe Targets", 0),
    ("Loop Probe A", 1, "Wait A", 0),
    ("Wait A", 0, "Fetch List Page (Probe)", 0),
    ("Fetch List Page (Probe)", 0, "Analyze List Probe", 0),
    ("Analyze List Probe", 0, "Loop Probe A", 0),
    ("Build Detail Probe Targets", 0, "Any Listings To Probe?", 0),
    ("Any Listings To Probe?", 0, "Loop Probe B", 0),
    ("Any Listings To Probe?", 1, "Build Step 0 Report", 0),
    ("Loop Probe B", 0, "Build Step 0 Report", 0),
    ("Loop Probe B", 1, "Wait B", 0),
    ("Wait B", 0, "Fetch Detail Page (Probe)", 0),
    ("Fetch Detail Page (Probe)", 0, "Analyze Detail Probe", 0),
    ("Analyze Detail Probe", 0, "Loop Probe B", 0),
    ("Build Step 0 Report", 0, "STEP 0 REPORT", 0),
])

write("workflows/4zida-step0-probe.json", {
    "name": "4zida.rs - STEP 0 live verification probe",
    "nodes": probe_nodes,
    "connections": probe_conns,
    "settings": {"executionOrder": "v1", "saveManualExecutions": True},
    "pinData": {}, "active": False, "tags": [],
})
