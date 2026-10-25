// Points of interest from Wikipedia and Wikidata, both keyless and
// CORS-enabled (port of Places.swift). Landmarks: Wikipedia geosearch within
// 10 km, ranked by 30-day page views. Cities: Wikidata, every city over a
// million people, ranked by population. Summaries are fetched on tap.

const cache = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const inflight = new Map();
const once = (key, fn) => {
  if (!inflight.has(key)) inflight.set(key, fn().catch((e) => { inflight.delete(key); throw e; }));
  return inflight.get(key);
};

export function fetchLandmarks(lat, lon) { return once(`lm:${lat}_${lon}`, () => landmarks(lat, lon)); }
export function fetchCities() { return once('cities', cities); }

async function landmarks(lat, lon) {
  const key = `lm:${lat.toFixed(3)}_${lon.toFixed(3)}`;
  const c = cache.get(key); if (c) return c;
  const q = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*', generator: 'geosearch',
    ggscoord: `${lat}|${lon}`, ggsradius: '10000', ggslimit: '50',
    prop: 'coordinates|pageviews|description', colimit: '50', pvipdays: '30',
  });
  const r = await fetch('https://en.wikipedia.org/w/api.php?' + q);
  const pages = (await r.json()).query?.pages || [];
  const out = pages.filter((p) => p.coordinates?.length).map((p) => ({
    id: 'wp' + p.pageid, title: p.title, subtitle: p.description || '', kind: 'landmark', wikiTitle: p.title,
    lat: p.coordinates[0].lat, lon: p.coordinates[0].lon,
    popularity: Object.values(p.pageviews || {}).reduce((s, v) => s + (v || 0), 0),
  }));
  if (out.length) cache.set(key, out);
  return out;
}

async function cities() {
  const c = cache.get('cities:v1'); if (c) return c;
  const query = `SELECT ?city ?cityLabel ?pop ?coord ?title WHERE {
    ?city wdt:P31/wdt:P279* wd:Q515; wdt:P1082 ?pop; wdt:P625 ?coord.
    FILTER(?pop > 1000000)
    OPTIONAL { ?article schema:about ?city; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?title. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }`;
  const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), { headers: { Accept: 'application/sparql-results+json' } });
  const rows = (await r.json()).results.bindings;
  const byId = new Map();
  for (const row of rows) {
    const qid = row.city.value.split('/').pop(), name = row.cityLabel?.value, pop = parseFloat(row.pop?.value);
    const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(row.coord?.value || '');
    if (!name || !m || !isFinite(pop) || /^Q\d+$/.test(name)) continue;
    if (byId.has(qid) && byId.get(qid).popularity >= pop) continue;
    byId.set(qid, {
      id: qid, title: name, subtitle: `${(pop / 1e6).toFixed(1)} million people`, kind: 'city',
      wikiTitle: row.title?.value || null, lat: parseFloat(m[2]), lon: parseFloat(m[1]), popularity: pop,
    });
  }
  const out = [...byId.values()];
  if (out.length) cache.set('cities:v1', out);
  return out;
}

const summaries = new Map();
export async function fetchSummary(place) {
  const title = place.wikiTitle || place.title;
  if (summaries.has(title)) return summaries.get(title);
  const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
  const j = await r.json();
  const s = {
    title: j.title || place.title, description: j.description || place.subtitle, extract: j.extract || '',
    // Ask the thumbnailer for a bigger version.
    image: j.thumbnail?.source?.replace(/\/\d+px-/, '/640px-') || null,
  };
  summaries.set(title, s);
  return s;
}
