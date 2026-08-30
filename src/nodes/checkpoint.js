/* Checkpoint — one durable row per category in the Checkpoint tab, refreshed
 * every N listings, so an interrupted run can be restarted near where it died. */
const s = $getWorkflowStaticData('global').zida;
return [{ json: {
  category: s.category,
  last_page: s.last_completed_page || 0,
  last_listing_id: s.last_written_id || '',
  listings_scanned: s.scanned,
  passed_filter: s.qualifying.length,
  written: s.detail_written || 0,
  errors: s.detail_errors || 0,
  status: s.dedup_total ? 'IN_PROGRESS' : 'PAGING',   // which phase was interrupted
  updated_at: new Date().toISOString()
} }];
