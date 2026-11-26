// Météo : Open-Meteo (modèles Météo-France). Seules les coordonnées du lieu sont envoyées.
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';

function parse(json) {
  const hourly = json && json.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const series = (name) => {
    const key = Object.keys(hourly).find((k) => k === name || k.startsWith(name + '_'));
    return key ? hourly[key] : [];
  };
  const precip = series('precipitation'), gust = series('wind_gusts_10m'), temp = series('temperature_2m'), code = series('weather_code');
  const out = [];
  hourly.time.forEach((s, i) => {
    if (precip[i] == null || gust[i] == null) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/.exec(s);
    if (!m) return;
    out.push({
      t: new Date(+m[1], +m[2] - 1, +m[3], +m[4]).getTime(),
      precip: precip[i], gust: gust[i], temp: temp[i] ?? 0, code: code[i] ?? 0,
    });
  });
  return out;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** Heures du modèle prioritaire, complétées par celles du modèle de secours là où il manque des données. */
export function mergeForecasts(primary, fallback) {
  const byHour = new Map(fallback.map((f) => [f.t, f]));
  for (const f of primary) byHour.set(f.t, f);
  return [...byHour.values()].sort((a, b) => a.t - b.t);
}

export async function fetchForecast(place) {
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&hourly=precipitation,wind_gusts_10m,temperature_2m,weather_code&wind_speed_unit=kmh&forecast_days=9&timezone=${encodeURIComponent(tz())}`;
  // Météo-France ne couvre qu'environ 4 jours : le modèle par défaut du service comble les jours suivants.
  const [mf, def] = await Promise.allSettled([get(base + '&models=meteofrance_seamless'), get(base)]);
  const rows = mergeForecasts(mf.status === 'fulfilled' ? parse(mf.value) : [], def.status === 'fulfilled' ? parse(def.value) : []);
  if (!rows.length) throw new Error('pas de données');
  return rows;
}

export async function searchPlaces(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  const json = await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=fr&format=json`);
  return (json.results || []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}
