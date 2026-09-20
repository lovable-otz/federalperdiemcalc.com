/* calculator.js — federalperdiemcalc.com
 * Tools: "tripPerDiem" (maximum lodging + M&IE for a trip, by destination and dates) and "rateLookup".
 *
 * DATA: assets/perdiem-data.js (window.PERDIEM) is generated from the official GSA Per Diem API
 *   (api.gsa.gov/travel/perdiem/v2) — FY2026 and FY2027 CONUS lodging, meals and M&IE tier tables, fetched
 *   2026-09-14. No rate is typed by hand. Refresh every August when GSA publishes the next fiscal year:
 *   `node tools/fetch-perdiem.mjs YOUR_API_DATA_GOV_KEY` (free key at api.data.gov/signup).
 * RULES used (GSA / FTR): federal fiscal year starts 1 October · lodging rate is the rate for the month of
 *   each night · first and last travel day get 75% of M&IE (the API's FirstLastDay value) · a destination
 *   not listed uses the standard CONUS rate. "GSA" is the agency name; the site is not affiliated with GSA.
 */
(function (root, factory) {
  const C = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = C; else root.CALCS = C;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let DATA = root && root.PERDIEM;   // { fy: { std:{lodging:[12], meals}, rows:[[state, city, county, meals, [12 lodging Jan..Dec]]], mie:[{total, FirstLastDay}] } }
  const r2 = n => Math.round(n * 100) / 100;
  const norm = s => String(s == null ? '' : s).trim();   // GSA ships some names with stray trailing spaces

  const fyOf = d => d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const parse = s => { const [y, m, dd] = String(s || '').split('-').map(Number); return y && m && dd ? new Date(Date.UTC(y, m - 1, dd)) : null; };
  const iso = d => d.toISOString().slice(0, 10);

  function rateFor(date, state, city) {
    const fy = DATA && DATA[fyOf(date)];
    if (!fy) return null;
    const row = fy.rows.find(r => norm(r[0]) === norm(state) && norm(r[1]) === norm(city));
    const lodging = row ? row[4][date.getUTCMonth()] : fy.std.lodging[date.getUTCMonth()];
    const meals = row ? row[3] : fy.std.meals;
    const tier = fy.mie.find(t => t.total === meals) || { total: meals, FirstLastDay: meals * 0.75 };
    return { fy: fyOf(date), lodging, meals, firstLast: tier.FirstLastDay, listed: !!row };
  }

  function trip({ state, city, start, end }) {
    const s = parse(start), e = parse(end);
    if (!s || !e || e < s) return { error: 'Choose a return date on or after the departure date.' };
    const days = Math.round((e - s) / 864e5) + 1;
    const lines = []; let lodging = 0, mie = 0, missing = false;
    for (let i = 0; i < days; i++) {
      const d = new Date(s.getTime() + i * 864e5);
      const r = rateFor(d, state, city);
      if (!r) { missing = true; continue; }
      const isNight = i < days - 1;
      const edge = i === 0 || i === days - 1;
      const dayMie = edge ? r.firstLast : r.meals;
      const dayLodging = isNight ? r.lodging : 0;
      lodging += dayLodging; mie += dayMie;
      lines.push({ date: iso(d), fy: r.fy, lodging: dayLodging, mie: dayMie, listed: r.listed });
    }
    return { days, nights: days - 1, lodging, mie: r2(mie), total: r2(lodging + mie), lines, missing };
  }

  const states = () => DATA ? [...new Set(Object.values(DATA).flatMap(f => f.rows.map(r => r[0])))].sort() : [];
  const cityOptions = s => {
    const set = new Set();
    for (const f of Object.values(DATA || {})) for (const r of f.rows) if (norm(r[0]) === norm(s.state)) set.add(norm(r[1]));
    return [{ value: '', label: 'Other / not listed (standard rate)' }].concat([...set].sort().map(c => ({ value: c, label: c })));
  };

  const tripPerDiem = {
    title: 'Per diem calculator',
    inputs: [
      { id: 'state', label: 'Destination state', type: 'select', default: 'CO', options: () => states().map(s => ({ value: s, label: s })) },
      { id: 'city', label: 'City / county', type: 'select', default: 'Denver / Aurora', options: cityOptions },
      { id: 'start', label: 'Departure date', type: 'date', default: '2026-10-05' },
      { id: 'end', label: 'Return date', type: 'date', default: '2026-10-08' },
    ],
    compute(v, fmt) {
      if (!DATA) return { warnings: ['Rate data did not load.'] };
      const t = trip(v);
      if (t.error) return { raw: t, warnings: [t.error] };
      const w = t.missing ? ['Some dates fall in a fiscal year whose rates are not published yet — those days are not included.'] : [];
      return {
        raw: { nights: t.nights, lodging: t.lodging, mie: t.mie, total: t.total },
        warnings: w,
        summary: [
          { label: 'Maximum per diem for the trip', value: fmt.money(t.total), strong: true },
          { label: `Lodging (${t.nights} night${t.nights === 1 ? '' : 's'})`, value: fmt.money(t.lodging) },
          { label: `Meals & incidentals (${t.days} day${t.days === 1 ? '' : 's'})`, value: fmt.money(t.mie) },
        ],
        rows: t.lines.map(l => ({ label: `${l.date} · FY${l.fy}${l.listed ? '' : ' · standard rate'}`, value: `${fmt.money(l.lodging)} + ${fmt.money(l.mie)}` })),
        notes: ['Lodging is a maximum before taxes; hotel taxes are reimbursed separately. Deduct meals provided at conferences or on flights. First and last day of travel receive 75% of M&IE.'],
      };
    },
  };

  const rateLookup = {
    title: 'Per diem rates lookup',
    inputs: [
      { id: 'fy', label: 'Fiscal year', type: 'select', default: '2027', options: () => Object.keys(DATA || {}).map(y => ({ value: y, label: `FY${y} (Oct ${y - 1} – Sep ${y})` })) },
      { id: 'state', label: 'State', type: 'select', default: 'NY', options: () => states().map(s => ({ value: s, label: s })) },
      { id: 'city', label: 'City / county', type: 'select', default: 'New York City', options: cityOptions },
    ],
    compute(v, fmt) {
      const f = DATA && DATA[v.fy];
      if (!f) return { warnings: ['Choose a fiscal year.'] };
      const row = f.rows.find(r => norm(r[0]) === norm(v.state) && norm(r[1]) === norm(v.city));
      const meals = row ? row[3] : f.std.meals;
      const lodging = row ? row[4] : f.std.lodging;
      const tier = f.mie.find(t => t.total === meals) || {};
      return {
        raw: { meals, maxLodging: Math.max(...lodging), firstLast: tier.FirstLastDay },
        summary: [
          { label: 'Meals & incidentals per day', value: fmt.money(meals), strong: true },
          { label: 'First / last day M&IE', value: fmt.money(tier.FirstLastDay) },
          { label: 'Lodging range', value: `${fmt.money0(Math.min(...lodging))} – ${fmt.money0(Math.max(...lodging))}` },
        ],
        rows: ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'].map(m => ({ label: `Lodging · ${m}`, value: fmt.money0(lodging[MONTHS.indexOf(m)]) })),
        notes: [row ? `County: ${row[2]}` : 'Not a listed destination — standard CONUS rate applies.'],
      };
    },
  };

  return {
    tripPerDiem, rateLookup,
    __setData: d => { DATA = d; },
    __pure: { trip, rateFor, fyOf },
    __tests: [
      { calc: 'tripPerDiem', name: 'standard rate, FY2027, 2 nights: 2×113 + 51+68+51', input: { state: 'AL', city: '', start: '2026-10-05', end: '2026-10-07' }, expect: { nights: 2, lodging: 226, mie: 170, total: 396 } },
      { calc: 'tripPerDiem', name: 'crosses 1 Oct: nights in FY2026 at $110', input: { state: 'AL', city: '', start: '2026-09-29', end: '2026-10-01' }, expect: { lodging: 220, mie: 170, total: 390 } },
      { calc: 'tripPerDiem', name: 'Birmingham FY2027 Nov, 2 nights: 2×135 + 60+80+60', input: { state: 'AL', city: 'Birmingham', start: '2026-11-10', end: '2026-11-12' }, expect: { lodging: 270, mie: 200, total: 470 } },
      { calc: 'tripPerDiem', name: 'Denver April 2027 peak season, 3 nights: 3×227 + 69+92+92+69', input: { state: 'CO', city: 'Denver / Aurora', start: '2027-04-10', end: '2027-04-13' }, expect: { lodging: 681, mie: 322, total: 1003 } },
      { calc: 'tripPerDiem', name: 'same-day trip: 75% M&IE, no lodging', input: { state: 'AL', city: '', start: '2026-10-05', end: '2026-10-05' }, expect: { nights: 0, lodging: 0, mie: 51 } },
      { calc: 'rateLookup', name: 'NYC FY2027: meals 92, max lodging 358', input: { fy: '2027', state: 'NY', city: 'New York City' }, expect: { meals: 92, maxLodging: 358, firstLast: 69 } },
      // Regression: GSA ships 13 FY2026 city names with trailing spaces. Untrimmed, a listed destination
      // silently fell back to the standard rate for the FY2026 half of a trip crossing 1 Oct.
      // By hand: 2 nights FY2026 Santa Monica @273 = 546 · M&IE 69 (first) + 92 + 69 (last) = 230.
      { calc: 'tripPerDiem', name: 'Santa Monica crossing 1 Oct keeps the listed rate, not standard', input: { state: 'CA', city: 'Santa Monica', start: '2026-09-29', end: '2026-10-01' }, expect: { nights: 2, lodging: 546, mie: 230, total: 776 } },
    ],
  };
});
