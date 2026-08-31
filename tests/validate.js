/* Structural validation of the built workflow JSON. */
const fs = require('fs'), vm = require('vm'), path = require('path');
let fail = 0;
const bad = (m) => { fail++; console.log('FAIL ' + m); };

for (const f of ['workflows/4zida-serbia-scraper.json', 'workflows/4zida-step0-probe.json']) {
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  const names = new Set();
  for (const n of wf.nodes) {
    if (names.has(n.name)) bad(f + ': duplicate node name ' + n.name);
    names.add(n.name);
    if (!n.type || n.typeVersion === undefined) bad(f + ': ' + n.name + ' missing type/typeVersion');
    if (!Array.isArray(n.position) || n.position.length !== 2) bad(f + ': ' + n.name + ' bad position');
    if (n.type === 'n8n-nodes-base.code') {
      // n8n wraps jsCode in an async function body, so top-level return is legal
      try { new vm.Script('(async function(){\n' + n.parameters.jsCode + '\n})'); }
      catch (e) { bad(f + ': ' + n.name + ' jsCode does not parse: ' + e.message); }
    }
  }
  for (const [src, c] of Object.entries(wf.connections)) {
    if (!names.has(src)) bad(f + ': connection from unknown node ' + src);
    (c.main || []).forEach((outs, i) => outs.forEach(t => {
      if (!names.has(t.node)) bad(f + ': ' + src + '[' + i + '] -> unknown node ' + t.node);
    }));
  }
  // every node except triggers must be reachable
  const reached = new Set(wf.nodes.filter(n => /Trigger|manualTrigger/i.test(n.type)).map(n => n.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [src, c] of Object.entries(wf.connections)) {
      if (!reached.has(src)) continue;
      (c.main || []).forEach(outs => outs.forEach(t => { if (!reached.has(t.node)) { reached.add(t.node); grew = true; } }));
    }
  }
  for (const n of wf.nodes) if (!reached.has(n.name)) bad(f + ': unreachable node ' + n.name);

  // every node referenced by a $('Name') expression must exist
  const blob = JSON.stringify(wf);
  const re = /\$\('([^']+)'\)/g; let m;
  while ((m = re.exec(blob)) !== null) if (!names.has(m[1])) bad(f + ": expression references missing node $('" + m[1] + "')");
  /* A node whose URL reads $json.<field> can only be fed by producers that
   * actually emit that field. A Google Sheets node REPLACES the item json with
   * the row it wrote, so putting one on a loop-back path silently strips the
   * field and the next request gets `undefined`. That shipped twice: once into
   * the Run Summary node, once into the pagination loop, where it capped every
   * run at 24 pages. */
  const PASSTHROUGH = new Set(['n8n-nodes-base.if', 'n8n-nodes-base.wait',
    'n8n-nodes-base.splitInBatches', 'n8n-nodes-base.noOp', 'n8n-nodes-base.merge']);
  const REPLACES_JSON = new Set(['n8n-nodes-base.googleSheets', 'n8n-nodes-base.httpRequest']);
  const byName = Object.fromEntries(wf.nodes.map(n => [n.name, n]));
  const feeders = (name) => Object.entries(wf.connections)
    .filter(([, c]) => (c.main || []).some(outs => outs.some(t => t.node === name)))
    .map(([src]) => src);

  for (const n of wf.nodes) {
    const url = n.parameters && n.parameters.url;
    const m = typeof url === 'string' && url.match(/^=\{\{\s*\$json\.(\w+)\s*\}\}$/);
    if (!m) continue;
    const field = m[1];
    const seen = new Set(), queue = feeders(n.name);
    while (queue.length) {
      const src = queue.shift();
      if (seen.has(src)) continue;
      seen.add(src);
      const p = byName[src];
      if (!p) continue;
      if (PASSTHROUGH.has(p.type)) { queue.push(...feeders(src)); continue; }
      if (REPLACES_JSON.has(p.type)) {
        bad(f + ': ' + n.name + ' reads $json.' + field + ' but is fed by ' + src +
            ' (' + p.type.split('.').pop() + '), which replaces the item json — the field will be undefined');
        continue;
      }
      if (p.type === 'n8n-nodes-base.code') {
        if (!p.parameters.jsCode.includes(field)) {
          bad(f + ': ' + n.name + ' reads $json.' + field + ' but producer ' + src + ' never sets it');
        }
        continue;
      }
      if (p.type === 'n8n-nodes-base.set') {
        const names = (p.parameters.assignments.assignments || []).map(a => a.name);
        if (!names.includes(field)) bad(f + ': ' + n.name + ' reads $json.' + field + ' but Set node ' + src + ' does not define it');
      }
    }
  }

  console.log('checked ' + f + ' (' + wf.nodes.length + ' nodes, ' + reached.size + ' reachable)');
}
console.log(fail ? '\n' + fail + ' structural problem(s)' : '\nstructure OK');
process.exit(fail ? 1 : 0);
