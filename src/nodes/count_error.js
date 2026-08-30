/* Count Error — a listing that failed for a non-block reason is logged and the
 * run carries on; one bad listing must never take down the whole category. */
const s = $getWorkflowStaticData('global').zida;
const j = $('Extract 4 Fields').first().json;
s.detail_errors = (s.detail_errors || 0) + 1;
return [{ json: Object.assign({}, j, { error_count: s.detail_errors }) }];
