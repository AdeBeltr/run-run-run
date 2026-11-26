// Logique pure (aucun accès au DOM) : créneaux, séries, textes. Voir spec.md §1 à §3.
export const RULES = { minValidKm: 5, weeklyGoal: 2, slotMs: 3600000 };
export const DEFAULT_THRESHOLDS = { maxGustKmh: 15, maxRainMMH: 0.5 };
const HOUR = 3600000;

// ---------- Dates (fuseau de l'appareil, semaine lundi → dimanche) ----------
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
export const weekStart = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
export const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const isWeekday = (d) => d.getDay() >= 1 && d.getDay() <= 5;
export const kindOf = (d) => (isWeekday(d) ? 'weekday' : 'weekend');
export const isValidRun = (r) => r.km >= RULES.minValidKm;

/** Semaine planifiée : la semaine en cours, ou la suivante le dimanche à partir de 15h. */
export function planningWeekStart(now) {
  const ws = weekStart(now);
  return now.getDay() === 0 && now.getHours() >= 15 ? addDays(ws, 7) : ws;
}

// ---------- Planificateur ----------
/** Créneaux préférés : matin, midi ou soir (en semaine et le week-end). */
export const DEFAULT_PREFS = { weekday: 'midi', weekend: 'matin' };
// Ordre d'essai en semaine : le créneau choisi d'abord, puis les autres (le matin n'est un repli que s'il est choisi).
const WEEKDAY_ORDER = {
  matin: ['morning', 'noon', 'earlyNoon', 'evening'],
  midi: ['noon', 'earlyNoon', 'evening'],
  soir: ['evening', 'noon', 'earlyNoon'],
};
// Week-end : heures de départ possibles par plage, et ordre d'essai.
const WEEKEND_WINDOWS = { matin: [8, 9, 10, 11], midi: [12, 13], soir: [17, 18, 19] };
const WEEKEND_ORDER = { matin: ['matin', 'midi', 'soir'], midi: ['midi', 'matin', 'soir'], soir: ['soir', 'midi', 'matin'] };

export function weekdayCandidates(day, meeting14) {
  const out = [];
  for (const [h, m] of [[7, 0], [7, 30], [8, 0]]) out.push({ tier: 'morning', start: at(day, h, m) });
  for (const [h, m] of [[12, 30], [13, 0]]) { // sortie de 1 h contenue dans la plage 12h–14h
    const start = at(day, h, m);
    // Avec une réunion à 14h, la sortie doit finir avant 13h30.
    if (meeting14 && start.getTime() + RULES.slotMs > at(day, 13, 30).getTime()) continue;
    out.push({ tier: 'noon', start });
  }
  out.push({ tier: 'earlyNoon', start: at(day, 11, 30) });
  for (const [h, m] of [[18, 0], [18, 30], [19, 0]]) out.push({ tier: 'evening', start: at(day, h, m) });
  return out;
}

export function weekendCandidates(day, window) {
  const hours = window ? WEEKEND_WINDOWS[window] : [...WEEKEND_WINDOWS.matin, ...WEEKEND_WINDOWS.midi, ...WEEKEND_WINDOWS.soir];
  return hours.map((h) => ({ tier: 'weekend', start: at(day, h) }));
}

/**
 * forecast : [{ t: ms de début d'heure, precip: mm, gust: km/h, temp: °C, code }]
 * Retourne { weekday, weekend, outlook, ordered }.
 */
export function plan({ now, forecast, meetings14 = [], doneKinds = [], thresholds = DEFAULT_THRESHOLDS, prefs = DEFAULT_PREFS }) {
  const weekdayTiers = WEEKDAY_ORDER[prefs.weekday] || WEEKDAY_ORDER.midi;
  const weekendWindows = WEEKEND_ORDER[prefs.weekend] || WEEKEND_ORDER.matin;
  const index = new Map(forecast.map((f) => [f.t, f]));
  const meet = new Set(meetings14);
  const done = new Set(doneKinds);
  const ws = planningWeekStart(now);
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(ws, i)).filter((d) => addDays(d, 1) > now);

  function evaluate(start) {
    const end = start.getTime() + RULES.slotMs;
    const first = new Date(start);
    first.setMinutes(0, 0, 0);
    let h = first.getTime();
    let gust = 0, precip = 0, tsum = 0, n = 0, code = 0;
    while (h < end) {
      const f = index.get(h);
      if (!f) return null;
      gust = Math.max(gust, f.gust);
      precip = Math.max(precip, f.precip);
      tsum += f.temp;
      n += 1;
      code = Math.max(code, f.code);
      h += HOUR;
    }
    const rain = precip > thresholds.maxRainMMH;
    const wind = gust > thresholds.maxGustKmh;
    return { gust, precip, temp: tsum / n, code, rain, wind, ok: !rain && !wind, score: gust + precip * 20 };
  }

  const make = (kind, tier, start, e) => ({
    id: `${kind}-${start.getTime()}`,
    kind, tier,
    start: start.getTime(), end: start.getTime() + RULES.slotMs,
    gust: e.gust, precip: e.precip, temp: e.temp, code: e.code,
  });

  let weekday = null;
  if (!done.has('weekday')) {
    const weekdays = days.filter(isWeekday);
    outer: for (const tier of weekdayTiers) {
      for (const day of weekdays) {
        let best = null;
        for (const c of weekdayCandidates(day, meet.has(dayKey(day))).filter((c) => c.tier === tier && c.start > now)) {
          const e = evaluate(c.start);
          if (e && e.ok && (!best || e.score < best.e.score)) best = { start: c.start, e };
        }
        if (best) { weekday = make('weekday', tier, best.start, best.e); break outer; }
      }
    }
  }

  let weekend = null;
  if (!done.has('weekend')) {
    outerW: for (const win of weekendWindows) {
      let best = null;
      for (const day of days.filter((d) => !isWeekday(d))) {
        for (const c of weekendCandidates(day, win)) {
          if (c.start <= now) continue;
          const e = evaluate(c.start);
          if (e && e.ok && (!best || e.score < best.e.score)) best = { start: c.start, e };
        }
      }
      if (best) { weekend = make('weekend', 'weekend', best.start, best.e); break outerW; }
    }
  }

  // Aperçu par jour (créneaux grisés quand rien n'est possible).
  const outlook = [];
  for (const day of days) {
    const cands = isWeekday(day)
      ? weekdayCandidates(day, meet.has(dayKey(day))).filter((c) => weekdayTiers.includes(c.tier))
      : weekendCandidates(day);
    const future = cands.filter((c) => c.start > now);
    if (!future.length) continue;
    const evals = future.map((c) => evaluate(c.start));
    if (evals.some((e) => e && e.ok)) { outlook.push({ day, available: true, reason: null }); continue; }
    const known = evals.filter(Boolean);
    if (!known.length) { outlook.push({ day, available: false, reason: 'noData' }); continue; }
    const rain = known.filter((e) => e.rain).length;
    const wind = known.filter((e) => e.wind).length;
    outlook.push({ day, available: false, reason: rain >= wind ? 'rain' : 'wind' });
  }

  const ordered = [weekday, weekend].filter(Boolean).sort((a, b) => a.start - b.start);
  return { weekday, weekend, outlook, ordered };
}

// ---------- Statistiques ----------
/** Courses valides (≥ 5 km) par semaine : Map lundi(ms) → nombre. */
export function weekCounts(runs) {
  const m = new Map();
  for (const r of runs) if (isValidRun(r)) {
    const k = weekStart(new Date(r.date)).getTime();
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
const prevWeek = (ms) => addDays(new Date(ms), -7).getTime();

export function currentWeekCount(runs, now) {
  return weekCounts(runs).get(weekStart(now).getTime()) || 0;
}

/** Semaines consécutives avec ≥ 2 courses. La semaine en cours ne casse pas la série. */
export function streak(runs, now, goal = RULES.weeklyGoal) {
  const counts = weekCounts(runs);
  const cur = weekStart(now).getTime();
  let w = (counts.get(cur) || 0) >= goal ? cur : prevWeek(cur);
  let n = 0;
  while ((counts.get(w) || 0) >= goal) { n += 1; w = prevWeek(w); }
  return n;
}

export function bestStreak(runs, goal = RULES.weeklyGoal) {
  const weeks = [...weekCounts(runs)].filter(([, c]) => c >= goal).map(([k]) => k).sort((a, b) => a - b);
  let best = 0, run = 0, last = null;
  for (const w of weeks) {
    run = last !== null && addDays(new Date(last), 7).getTime() === w ? run + 1 : 1;
    best = Math.max(best, run);
    last = w;
  }
  return best;
}

/** Km cumulés (toutes les courses, sans seuil) sur le mois ou l'année de `now`. */
export function km(runs, now, granularity) {
  return runs
    .filter((r) => {
      const d = new Date(r.date);
      return d.getFullYear() === now.getFullYear() && (granularity === 'year' || d.getMonth() === now.getMonth());
    })
    .reduce((s, r) => s + r.km, 0);
}

/** La semaine dernière n'a pas atteint l'objectif (et l'app était installée avant son début). */
export function lastWeekMissed(runs, now, installDate, goal = RULES.weeklyGoal) {
  const last = prevWeek(weekStart(now).getTime());
  if (installDate > last) return false;
  return (weekCounts(runs).get(last) || 0) < goal;
}

// ---------- Textes (ton sympa, jamais de reproche) ----------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (opts) => new Intl.DateTimeFormat('fr-FR', opts);
export const dayName = (d) => cap(fmt({ weekday: 'long' }).format(d));
export const shortDay = (d) => cap(fmt({ weekday: 'short' }).format(d).replace('.', ''));
export const monthName = (d) => fmt({ month: 'long' }).format(d).toUpperCase();
export function timeLabel(d) {
  const h = d.getHours(), m = d.getMinutes();
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}
export const kmLabel = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function sky(code) {
  if (code === 0) return 'ciel dégagé';
  if (code <= 2) return 'quelques nuages';
  if (code === 3) return 'ciel couvert';
  if (code === 45 || code === 48) return 'un peu de brume';
  if (code >= 51 && code <= 57) return 'bruine légère';
  if (code >= 61 && code <= 67) return 'de la pluie';
  if (code >= 71 && code <= 77) return 'de la neige';
  if (code >= 80 && code <= 82) return 'des averses';
  if (code >= 95) return "de l'orage";
  return 'météo calme';
}
export function proposalPhrase(p) {
  const s = new Date(p.start);
  return `${dayName(s)} ${timeLabel(s)}, ${sky(p.code)}. Ça te dit ?`;
}
export const reasonLabel = (r) => ({ rain: 'pluie', wind: 'trop de vent', noData: 'météo indisponible' }[r]);

export function checkInMessage(c) {
  if (!c) return null;
  if (c.drank && c.heavy) return 'Grosse veille ? Une petite sortie douce, à ton rythme, te fera du bien. Sans pression.';
  if (c.drank) return "Petite soirée hier ? Une foulée tranquille t'aidera à te sentir mieux. À ton rythme !";
  if (c.heavy) return 'Repas copieux ? Parfait prétexte pour une petite sortie, sans forcer.';
  return null;
}
export const missedWeekMessage = (best, goal = RULES.weeklyGoal) => {
  const runs = goal > 1 ? `${goal} sorties` : 'une sortie';
  return best > 0
    ? `Nouvelle semaine, on repart ! Ta meilleure série reste à ${best}. ${runs[0].toUpperCase()}${runs.slice(1)} et c'est reparti.`
    : `Nouvelle semaine, on repart ! ${runs[0].toUpperCase()}${runs.slice(1)} et c'est lancé.`;
};
export const EMPTY_WEEK = 'Semaine pluvieuse ou venteuse : on se repose, on se retrouve vite.';
export const WEEK_DONE = 'Semaine validée ! Objectif atteint, bravo.';
export const FIRST_USE = "C'est parti ! Voici ta première sortie.";
