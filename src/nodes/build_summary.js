/* Build Summary — end-of-run tally across both stages. */
const store = $getWorkflowStaticData('global');
const s = store.zida;

const written = s.detail_written || 0;
const errors = s.detail_errors || 0;
const queued = s.dedup_total || 0;

return [{ json: {
  category: s.category,
  category_base_url: s.base_url,
  min_price_eur: s.min_price_eur,

  pagination_style: s.pagination_style,
  pages_fetched: s.pages_fetched,
  last_completed_page: s.last_completed_page || 0,
  stop_reason: s.stop_reason || 'completed',

  stage1_listings_scanned: s.scanned,
  stage1_skipped_no_price: s.unpriced,
  stage1_rejected_not_a_listing_url: s.rejected_url_shape || 0,
  rejected_url_samples: s.rejected_url_samples || [],
  stage1_below_threshold: s.below_threshold,
  stage1_passed_price_filter: s.qualifying.length,
  duplicates_dropped: s.duplicates_dropped || 0,
  resume_skipped: s.resume_skipped || 0,
  detail_pages_queued: queued,

  written_to_sheet: written,
  errors_logged: errors,
  errors_no_advertiser_block: s.detail_no_advertiser || 0,
  rows_with_a_blank_field: s.detail_blank_fields || 0,
  unaccounted: Math.max(0, queued - written - errors),

  list_page_fetch_errors: s.list_fetch_errors || 0,
  price_strategies_used: JSON.stringify(s.strategies_used || {}),
  resume_warning: s.resume_warning || '',

  last_written_id: s.last_written_id || '',

  started_at: s.started_at,
  finished_at: new Date().toISOString(),
  RESUME_HINT: 'To resume: set Config.resume_from_page = ' + (s.last_completed_page || 1) +
               ' and Config.resume_after_listing_id = ' + (s.last_written_id || '(see Checkpoint tab)')
} }];
