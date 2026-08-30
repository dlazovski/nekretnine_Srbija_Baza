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
  console.log('checked ' + f + ' (' + wf.nodes.length + ' nodes, ' + reached.size + ' reachable)');
}
console.log(fail ? '\n' + fail + ' structural problem(s)' : '\nstructure OK');
process.exit(fail ? 1 : 0);
