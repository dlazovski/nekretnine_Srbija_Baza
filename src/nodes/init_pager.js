/* Init Pager — resets the run accumulator and emits the first page URL.
 * All loop state lives in workflow static data so the items travelling round
 * the pagination loop stay tiny (34k listings never ride inside an item). */
const cfg = $('Config').first().json;
const base = String(cfg.category_base_url || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/(www\.)?4zida\.rs\/\S+/.test(base)) {
  throw new Error('Config.category_base_url must be one of the 5 4zida category URLs. Got: ' + base);
}

const CATEGORY_LABELS = {
  'prodaja-stanova': 'Stanovi (apartments)',
  'prodaja-kuca': 'Kuce (houses)',
  'prodaja-poslovnih-prostora': 'Poslovni prostori (commercial)',
  'prodaja-placeva': 'Placevi (land)',
  'prodaja-garaza-i-parkinga': 'Garaze i parking (garages)'
};
const slug = base.replace(/^https:\/\/(www\.)?4zida\.rs\//, '').split(/[/?]/)[0];

const store = $getWorkflowStaticData('global');
store.zida = {
  base_url: base,
  category_slug: slug,
  category: CATEGORY_LABELS[slug] || slug,
  min_price_eur: Number(cfg.min_price_eur) || 100000,
  resume_from_page: Math.max(1, Number(cfg.resume_from_page) || 1),
  resume_after_listing_id: String(cfg.resume_after_listing_id || '').trim().toLowerCase(),
  max_pages: Math.max(0, Number(cfg.max_pages) || 0),
  exclude_phones: String(cfg.exclude_phones || '').split(',').map(s => s.trim()).filter(Boolean),
  page_template: null,
  pagination_style: 'not-detected-yet',
  calibrated: false,
  page: 1,
  pages_fetched: 0,
  scanned: 0,
  unpriced: 0,
  below_threshold: 0,
  qualifying: [],
  prev_ids: [],
  strategies_used: {},
  list_fetch_errors: 0,
  detail_written: 0,
  detail_errors: 0,
  detail_blank_fields: 0,
  stop_reason: '',
  started_at: new Date().toISOString()
};

// Always fetch page 1 first, even when resuming: page 1 is what tells us the
// real pagination pattern, so a resume jump lands on the right URL.
return [{ json: { page: 1, next_url: base, done: false, blocked: false, category: store.zida.category } }];
