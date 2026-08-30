/* Count Written — runs only after the Google Sheets append actually succeeded,
 * so the summary reports rows really in the sheet, not rows we hoped to write. */
const s = $getWorkflowStaticData('global').zida;
const j = $('Extract 4 Fields').first().json;
s.detail_written = (s.detail_written || 0) + 1;
s.last_written_id = j.listing_id || s.last_written_id || '';
return [{ json: Object.assign({}, j, { written_count: s.detail_written }) }];
