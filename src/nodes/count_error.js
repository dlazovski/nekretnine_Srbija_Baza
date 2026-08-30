/* Count Error — a listing that failed for a non-block reason is logged and the
 * run carries on; one bad listing must never take down the whole category. */
const s = $getWorkflowStaticData('global').zida;
const j = $('Extract 4 Fields').first().json;
s.detail_errors = (s.detail_errors || 0) + 1;
s.error_samples = (s.error_samples || []);
if (s.error_samples.length < 8) s.error_samples.push({ link: j.link, reason: String(j.error_message || '').slice(0, 160) });
return [{ json: Object.assign({}, j, { error_count: s.detail_errors }) }];
