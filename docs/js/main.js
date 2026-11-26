import * as C from './core.js';
import { loadState, saveState, resetState } from './store.js';
import { fetchForecast, searchPlaces } from './weather.js';
import { downloadICS } from './ics.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

let S = loadState();
const ui = { tab: 'home', modal: null, step: 0, results: [], query: '', picked: null, busy: '', info: '', now: null };
let view = { proposals: [] };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const save = () => { if (!DEMO) saveState(S); };
const nowDate = () => (ui.now ? new Date(ui.now) : new Date());

// ---------- Démo (?demo=1 : données fictives, aucun appel réseau) ----------
function seedDemo() {
  const now = nowDate();
  const ws = C.weekStart(now);
  S.onboardingDone = true;
  S.place = { name: 'Lyon', lat: 45.76, lon: 4.84 };
  S.installDate = C.addDays(ws, -40).getTime();
  const forecast = [];
  for (let i = -24; i < 9 * 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), i + 0);
    const dow = d.getDay();
    const f = { t: d.getTime(), precip: 0, gust: 9, temp: 11, code: 1 };
    if (params.get('demo') === 'rain') f.precip = 3;
    else if (dow === 4) f.precip = 2; // jeudi pluvieux
    forecast.push(f);
  }
  S.forecast = forecast;
  S.forecastFetchedAt = now.getTime();
  const mk = (back, km) => ({ id: 'd' + back, date: C.addDays(ws, -back).getTime() + 12 * 3600e3, km, durationSec: 1900, source: 'health' });
  S.runs = [mk(3, 6.1), mk(5, 5.3), mk(10, 7), mk(12, 5.6), mk(17, 8), mk(19, 5.1), mk(24, 5.4)];
  if (params.has('week1')) S.runs.push({ id: 'cur', date: now.getTime() - 3600e3, km: 5.2, durationSec: 1700, source: 'manual' });
  S.meetings14 = [];
  S.checkIns = {};
  // Scénarios de simulation : ?scenario=week2,missed,both,checkin
  const sc = (params.get('scenario') || '').split(',');
  const at12 = (d) => C.addDays(ws, d).getTime() + 12 * 3600e3;
  if (sc.includes('week2')) S.runs.push({ id: 's1', date: at12(0), km: 6.1, durationSec: 1900, source: 'manual' }, { id: 's2', date: at12(1), km: 5.4, durationSec: 1700, source: 'manual' });
  if (sc.includes('both')) S.runs.push({ id: 's1', date: at12(1), km: 6.1, durationSec: 1900, source: 'manual' }, { id: 's2', date: at12(5), km: 8, durationSec: 2600, source: 'manual' });
  if (sc.includes('missed')) S.runs = S.runs.filter((r) => r.id !== 'd3');
  if (sc.includes('checkin')) S.checkIns[C.dayKey(now)] = { drank: true, heavy: false, answered: true };
}
if (DEMO) { if (params.has('now')) ui.now = new Date(params.get('now')).getTime(); seedDemo(); if (params.has('tab')) ui.tab = params.get('tab'); }

// ---------- Rafraîchissement météo ----------
async function refreshWeather(force = false) {
  if (DEMO || !S.place) return;
  const age = Date.now() - (S.forecastFetchedAt || 0);
  if (!force && age < 30 * 60e3 && S.forecast.length) return;
  ui.busy = 'weather';
  render();
  try {
    S.forecast = await fetchForecast(S.place);
    S.forecastFetchedAt = Date.now();
    S.weatherError = false;
    S.weatherErrorMsg = '';
  } catch (e) {
    S.weatherError = true;
    S.weatherErrorMsg = String((e && e.message) || e).slice(0, 60);
  }
  ui.busy = '';
  save();
  render();
}

// ---------- Modèle de l'accueil ----------
function homeModel(now) {
  const th = S.thresholds;
  const pw = C.planningWeekStart(now);
  const nextWeek = pw.getTime() !== C.weekStart(now).getTime();
  const inWeek = (ms) => C.weekStart(new Date(ms)).getTime() === pw.getTime();
  const valid = S.runs.filter(C.isValidRun).filter((r) => inWeek(r.date));
  const doneKinds = [...new Set(valid.map((r) => C.kindOf(new Date(r.date))))];
  const meetings = S.meetings14;
  const result = C.plan({ now, forecast: S.forecast, meetings14: meetings, doneKinds, thresholds: th, prefs: S.prefs });
  // Les sorties acceptées restent affichées tant que le type n'est pas fait.
  const accepted = S.accepted.filter((a) => inWeek(a.start) && a.end > now.getTime() - 3 * 3600e3 && !doneKinds.includes(a.kind));
  const byKind = { weekday: result.weekday, weekend: result.weekend };
  for (const a of accepted) byKind[a.kind] = { ...a, accepted: true };
  const proposals = [byKind.weekday, byKind.weekend].filter(Boolean).sort((a, b) => a.start - b.start);
  const weekDone = valid.length >= S.goal;
  const meetingDays = [0, 1, 2, 3, 4].map((i) => C.addDays(pw, i)).filter((d) => C.addDays(d, 1) > now);
  const key = C.dayKey(now);
  const ci = S.checkIns[key];
  const todayIdx = proposals.findIndex((p) => C.dayKey(new Date(p.start)) === key && p.end > now.getTime());
  const showCheckIn = todayIdx >= 0 && (!ci || ci.drank || ci.heavy);
  const bothDone = doneKinds.includes('weekday') && doneKinds.includes('weekend');
  const dow = now.getDay();
  const missed = (dow === 1 || dow === 2) && C.lastWeekMissed(S.runs, now, S.installDate, S.goal);
  const reminder = S.accepted.find((a) => !doneKinds.includes(a.kind) && now.getTime() >= a.start - 30 * 60e3 && now.getTime() < a.end);
  return {
    now, proposals, outlook: result.outlook, weekDone, nextWeek, meetingDays, meetings,
    count: C.currentWeekCount(S.runs, now), streak: C.streak(S.runs, now, S.goal), best: C.bestStreak(S.runs, S.goal),
    ci, showCheckIn, todayIdx, bothDone, missed, reminder, firstUse: S.runs.length === 0,
  };
}

// ---------- Composants ----------
const tabbar = () => `<nav class="tabbar">${[['home', 'Mes runs', 'i-home'], ['bilan', 'Km', 'i-km'], ['set', 'Réglages', 'i-set']]
  .map(([k, l, i]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-action="tab" data-v="${k}"><svg><use href="#${i}"/></svg>${l}</button>`).join('')}</nav>`;

const brand = (m) => `<div class="brand"><div class="comic outline">Run run run !</div><small>${esc(S.place ? S.place.name : '')}${m ? ' · ' + m : ''}</small></div>`;

function weatherNote() {
  const t = S.forecastFetchedAt ? C.timeLabel(new Date(S.forecastFetchedAt)) : null;
  if (ui.busy === 'weather') return `<span class="note">Météo en cours de mise à jour…</span>`;
  if (!S.forecast.length) return `<span class="note">${S.weatherError ? `Météo injoignable (${esc(S.weatherErrorMsg || 'erreur réseau')})` : 'Pas encore de météo'}<button data-action="refresh">Réessayer</button></span>`;
  if (S.weatherError) return `<span class="note">Météo non actualisée · dernière mise à jour ${t}<button data-action="refresh">Réessayer</button></span>`;
  return `<span class="note">Météo mise à jour à ${t}<button data-action="refresh">Actualiser</button></span>`;
}

const cells = (p) => {
  const d = new Date(p.start);
  return `<div class="cells"><div><small>Jour</small>${C.shortDay(d)} ${d.getDate()}</div><div><small>Heure</small>${C.timeLabel(d)}</div><div><small>Lieu</small>${esc(S.place ? S.place.name : '')}</div></div>`;
};
const stickers = (p) => `<div class="stickers"><span class="sticker">${p.precip < 0.05 ? '0 mm pluie' : p.precip.toFixed(1).replace('.', ',') + ' mm pluie'}</span><span class="sticker">Rafales ${Math.round(p.gust)} km/h</span><span class="sticker">${Math.round(p.temp)}°</span></div>`;

function heroCard(p) {
  if (p.accepted) {
    const d = new Date(p.start);
    return `<section class="panel hero planned"><div class="comic" style="font-size:19px;color:var(--pink);text-shadow:1px 1px 0 #111,2px 2px 0 #111">Prévue : ${C.dayName(d)} ${C.timeLabel(d)}</div>${cells(p)}${stickers(p)}
      <div style="font-size:13px;font-weight:900">✓ C'est noté ! Ajoute-la à ton agenda si tu veux.</div>
      <div class="row2"><button class="btn ghost" data-action="ics" data-id="${p.id}">Dans mon agenda</button><button class="btn ghost" data-action="done" data-id="${p.id}">C'est fait !</button></div></section>`;
  }
  return `<section class="panel hero"><svg class="shoe"><use href="#shoe"/></svg>
    <div class="bubble">${esc(C.proposalPhrase(p))}</div>${cells(p)}${stickers(p)}
    <button class="btn main" data-action="accept" data-id="${p.id}">Ça me va !</button>
    <div class="row2"><button class="btn ghost" data-action="ics" data-id="${p.id}">Dans mon agenda</button><button class="btn ghost" data-action="done" data-id="${p.id}">C'est fait !</button></div></section>`;
}

function nextCard(p) {
  const d = new Date(p.start);
  return `<section class="panel next"><div><small>${p.accepted ? 'Prévue' : 'Ensuite'}</small><div class="comic">${C.dayName(d)} ${C.timeLabel(d)}</div></div>
    <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="tag">${p.precip < 0.05 ? '0' : p.precip.toFixed(1).replace('.', ',')} mm · ${Math.round(p.gust)} km/h</span>
    ${p.accepted ? '' : `<button class="chip" data-action="accept" data-id="${p.id}">Ça me va !</button>`}</div></section>`;
}

function outlookCard(m) {
  const rows = m.outlook.map((o) => `<div class="day ${o.available ? 'ok' : ''}"><span>${C.dayName(o.day)}</span><span class="r">${o.available ? 'dispo' : C.reasonLabel(o.reason)}</span></div>`).join('');
  return `<section class="panel empty"><div class="comic" style="font-size:18px;color:var(--red)">Splash ! ${esc(C.EMPTY_WEEK)}</div>
    <div style="font-size:12px;font-weight:700">Voilà ce qui bloque :</div>${rows || '<div class="help">Plus de créneau cette semaine.</div>'}</section>`;
}

function partyCard() {
  return `<section class="panel party"><svg class="bg"><use href="#burst"/></svg><div class="comic">Bravo !</div><div class="msg2">${esc(C.WEEK_DONE)}</div></section>`;
}

function checkInCard(m) {
  const c = m.ci || {};
  const msg = C.checkInMessage(c);
  return `<section class="panel card"><b class="t">Comment s'est passée ta veille ?</b>
    <div class="chips"><button class="chip ${c.drank ? 'on' : ''}" data-action="checkin" data-v="drank">Soirée arrosée</button>
    <button class="chip ${c.heavy ? 'on' : ''}" data-action="checkin" data-v="heavy">Repas gras</button>
    <button class="chip" data-action="checkin" data-v="none">Rien de spécial</button></div>${msg ? `<div class="msg">${esc(msg)}</div>` : ''}</section>`;
}

function homeHtml() {
  const now = nowDate();
  const m = homeModel(now);
  view = m;
  const [first, second] = m.proposals;
  const parts = [brand(m.nextWeek ? 'semaine prochaine' : '')];
  if (m.missed) parts.push(`<section class="panel card cy"><b class="t">Nouvelle semaine !</b><div style="font-weight:700">${esc(C.missedWeekMessage(m.best, S.goal))}</div></section>`);
  if (m.reminder) {
    const mins = Math.round((m.reminder.start - now.getTime()) / 60000);
    parts.push(`<section class="panel card ye"><b class="t">${mins > 0 ? `Ta sortie dans ${mins} min` : "C'est l'heure !"}</b><div style="font-weight:700">Baskets aux pieds, on y va. Pense à marquer « C'est fait ! » après.</div></section>`);
  }
  if (m.nextWeek) parts.push(`<div class="comic outline" style="font-size:16px">La semaine qui arrive</div>`);
  if (m.weekDone) parts.push(partyCard());
  if (first) {
    if (m.firstUse && !first.accepted) parts.push(`<div class="comic outline" style="font-size:15px">${esc(C.FIRST_USE)}</div>`);
    if (m.weekDone) parts.push(`<div class="comic outline" style="font-size:15px">Bonus si tu veux</div>`);
    parts.push(heroCard(first));
    if (m.showCheckIn && m.todayIdx === 0) parts.push(checkInCard(m));
    if (second) parts.push(nextCard(second));
    if (m.showCheckIn && m.todayIdx === 1) parts.push(checkInCard(m));
  } else if (m.bothDone) {
    if (!m.weekDone) parts.push(`<section class="panel card ye"><b class="t">Tu as couru en semaine et le week-end !</b><div style="font-weight:700">Plus rien à proposer cette semaine. On se retrouve dimanche soir pour la suivante.</div></section>`);
  } else parts.push(outlookCard(m));
  parts.push(`<div class="tiles"><div class="panel tile"><small>Cette semaine</small><span class="comic">${m.count} / ${S.goal}</span><div class="pips">${Array.from({ length: S.goal }, (_, i) => `<b class="${i < m.count ? 'on' : ''}"></b>`).join('')}</div></div>
    <div class="panel tile cy"><small>Série</small><span class="comic">${m.streak} sem.</span><small>Record : ${m.best}</small></div></div>`);
  parts.push(`<button class="btn ghost" data-action="add-run">J'ai déjà couru cette semaine</button>`);
  parts.push(weatherNote());
  return `<main class="screen">${parts.join('')}</main>`;
}

function bilanHtml() {
  const now = nowDate();
  const month = C.km(S.runs, now, 'month'), year = C.km(S.runs, now, 'year');
  const best = C.bestStreak(S.runs, S.goal);
  return `<main class="screen">
    <div class="comic outline" style="font-size:28px">Km</div>
    <section class="panel bigp"><svg class="bg"><use href="#burst"/></svg><small>${C.monthName(now)}</small><div class="n">${C.kmLabel(month)}</div><small>kilomètres ce mois-ci !</small></section>
    <div class="burstrow"><div class="bw"><svg style="color:var(--yellow)"><use href="#burst"/></svg><span>${Math.round(year)}<small>km cette année</small></span></div>
    <div class="bw"><svg style="color:var(--cyan)"><use href="#burst"/></svg><span>${best}<small>sem. record</small></span></div></div>
    <div class="footbar">Run run run !</div>
    <button class="btn" data-action="add-run">Ajouter une course</button></main>`;
}

function settingsHtml() {
  const th = S.thresholds;
  const now = nowDate();
  const pw = C.planningWeekStart(now);
  const meetingDays = [0, 1, 2, 3, 4].map((i) => C.addDays(pw, i)).filter((d) => C.addDays(d, 1) > now);
  const prefChips = (kind) => ['matin', 'midi', 'soir'].map((v) =>
    `<button class="chip ${S.prefs[kind] === v ? 'on' : ''}" data-action="pref" data-v="${kind}:${v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join('');
  return `<main class="screen">
    <div class="comic outline" style="font-size:28px">Réglages</div>
    <span class="sect">Lieu</span>
    <div class="panel list"><div class="item"><b>${esc(S.place ? S.place.name : 'Aucun')}</b><button class="link" data-action="edit-place">Modifier ›</button></div></div>
    <span class="sect">Objectif</span>
    <div class="panel list"><div class="item"><span>Runs par semaine</span><div class="stepper"><button data-action="goal" data-v="-1" aria-label="moins">−</button>${S.goal}<button data-action="goal" data-v="1" aria-label="plus">+</button></div></div></div>
    <span class="sect">Créneau préféré</span>
    <div class="panel list">
      <div class="item col"><span>En semaine</span><div class="chips">${prefChips('weekday')}</div></div>
      <div class="item col"><span>Le week-end</span><div class="chips">${prefChips('weekend')}</div></div>
    </div>
    ${meetingDays.length ? `<span class="sect">Réu à 14h ?</span>
    <div class="panel list"><div class="item col"><span>Coche les jours où tu as une réunion à 14h</span><div class="chips">${meetingDays.map((d) => {
      const k = C.dayKey(d);
      return `<button class="chip ${S.meetings14.includes(k) ? 'on' : ''}" data-action="meeting" data-v="${k}">${C.shortDay(d)}</button>`;
    }).join('')}</div></div></div>` : ''}
    <span class="sect">Météo</span>
    <div class="panel list">
      <div class="item"><span>Rafales max</span><div class="stepper"><button data-action="gust" data-v="-1" aria-label="moins">−</button>${th.maxGustKmh} km/h<button data-action="gust" data-v="1" aria-label="plus">+</button></div></div>
      <div class="item"><span>Pluie tolérée</span><div class="stepper"><button data-action="rain" data-v="-0.1" aria-label="moins">−</button>${String(th.maxRainMMH.toFixed(1)).replace('.', ',')} mm/h<button data-action="rain" data-v="0.1" aria-label="plus">+</button></div></div>
    </div>
    <span class="sect">Données</span>
    <div class="panel list">
      <div class="item"><span>Sauvegarder mes courses</span><button class="link" data-action="export">Exporter</button></div>
      <div class="item"><span>Restaurer une sauvegarde</span><label class="link" style="font-weight:900;text-decoration:underline;cursor:pointer">Choisir<input id="restore" type="file" accept=".json,application/json" hidden></label></div>
      <div class="item"><span>Tout effacer sur cet appareil</span><button class="link" data-action="reset">Effacer</button></div>
    </div>
    ${ui.info ? `<div class="msg">${esc(ui.info)}</div>` : ''}
    </main>`;
}

function placeSearchHtml(withButtons) {
  return `<input class="input" id="q" placeholder="Ta ville" value="${esc(ui.query)}" autocomplete="off" autocapitalize="words">
    <div class="results" id="results">${resultsHtml()}</div>`;
}
function resultsHtml() {
  return ui.results.map((r, i) => `<button class="result ${ui.picked === i ? 'sel' : ''}" data-action="pick" data-v="${i}"><span><b>${esc(r.name)}</b>${r.detail ? ' · ' + esc(r.detail) : ''}</span><span>${ui.picked === i ? '✓' : ''}</span></button>`).join('');
}

function onboardingHtml() {
  if (ui.step === 0) return `<main class="screen"><div class="art"><svg width="210" height="210"><use href="#shoe"/></svg></div>
    <div class="comic outline" style="font-size:40px;transform:rotate(-3deg);line-height:1.05">Move<br>your<br><span class="pink">body.</span></div>
    <div class="dotsrow"><i class="on"></i><i></i></div><button class="btn pinkb" data-action="step" data-v="1">C'est parti !</button></main>`;
  if (ui.step === 1) return `<main class="screen"><div class="comic outline" style="font-size:30px">Où tu cours ?</div>${placeSearchHtml()}
    <div style="flex:1"></div><div class="dotsrow"><i></i><i class="on"></i></div>
    <button class="btn pinkb" data-action="place-ok" ${ui.picked === null ? 'disabled' : ''}>Valider</button></main>`;
}

function modalHtml() {
  const m = ui.modal;
  if (!m) return '';
  if (m.type === 'run') {
    const now = nowDate();
    const days = [];
    for (let d = C.weekStart(now); d <= now; d = C.addDays(d, 1)) days.push(d);
    return `<div class="modal" data-action="close"><div class="panel" data-stop>
    <div class="comic">Quel jour ?</div>
    <div class="chips">${days.map((d) => `<button class="chip ${m.day === C.dayKey(d) ? 'on' : ''}" data-action="run-day" data-v="${C.dayKey(d)}">${C.shortDay(d)}</button>`).join('')}</div>
    <div class="comic" style="font-size:16px">Combien de km ?</div>
    <input class="input" id="runkm" type="text" inputmode="decimal" value="${esc(m.km || '5,0')}" autocomplete="off">
    <p class="help">Une course d'au moins 5 km compte dans ta série.</p>
    <button class="btn main" data-action="save-run">C'est fait !</button><button class="btn ghost" data-action="close">Annuler</button></div></div>`;
  }
  if (m.type === 'place') return `<div class="modal" data-action="close"><div class="panel" data-stop><div class="comic">Changer de lieu</div>${placeSearchHtml()}
    <button class="btn main" data-action="place-save" ${ui.picked === null ? 'disabled' : ''}>Valider</button><button class="btn ghost" data-action="close">Annuler</button></div></div>`;
  if (m.type === 'reset') return `<div class="modal" data-action="close"><div class="panel" data-stop><div class="comic">Tout effacer ?</div>
    <p class="help">Lieu, courses, réglages : tout disparaît de cet appareil. Ça ne peut pas être annulé.</p>
    <button class="btn main" data-action="reset-ok">Oui, effacer</button><button class="btn ghost" data-action="close">Garder</button></div></div>`;
  return '';
}

// ---------- Rendu ----------
function render() {
  const keepQ = document.activeElement && document.activeElement.id === 'q';
  let html;
  if (!S.onboardingDone) html = onboardingHtml();
  else html = (ui.tab === 'set' ? settingsHtml() : ui.tab === 'bilan' ? bilanHtml() : homeHtml()) + tabbar();
  root.innerHTML = html + modalHtml();
  if (keepQ) { const q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

// ---------- Actions ----------
let searchTimer;
const clean = (ms) => S.runs.filter((r) => r.id !== ms);
function startPlaceSearch(value) {
  ui.query = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try { ui.results = await searchPlaces(value); } catch { ui.results = []; }
    ui.picked = null;
    const el = document.getElementById('results');
    if (el) el.innerHTML = resultsHtml();
    const ok = document.querySelector('[data-action="place-ok"],[data-action="place-save"]');
    if (ok) ok.disabled = true;
  }, 300);
}

function exportBackup() {
  const data = { app: 'run-run-run', version: 1, exportedAt: new Date().toISOString(), runs: S.runs, goal: S.goal, prefs: S.prefs, thresholds: S.thresholds, place: S.place };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `run-run-run-sauvegarde-${C.dayKey(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const actions = {
  tab: (v) => { ui.tab = v; ui.info = ''; window.scrollTo(0, 0); },
  export: () => { exportBackup(); return false; },
  step: (v) => { ui.step = Number(v); },
  pick: (v) => {
    ui.picked = Number(v);
    document.getElementById('results').innerHTML = resultsHtml();
    const ok = document.querySelector('[data-action="place-ok"],[data-action="place-save"]');
    if (ok) ok.disabled = false;
    return false;
  },
  'place-ok': () => { S.place = placeFrom(); S.onboardingDone = true; ui.picked = null; ui.results = []; ui.tab = 'home'; save(); refreshWeather(true); },
  'place-save': () => { S.place = placeFrom(); S.forecast = []; S.forecastFetchedAt = null; ui.modal = null; ui.picked = null; ui.results = []; save(); refreshWeather(true); },
  'edit-place': () => { ui.modal = { type: 'place' }; ui.query = ''; ui.results = []; ui.picked = null; },
  accept: (v) => {
    const p = view.proposals.find((x) => x.id === v);
    if (!p) return;
    S.accepted = S.accepted.filter((a) => a.kind !== p.kind || C.weekStart(new Date(a.start)).getTime() !== C.weekStart(new Date(p.start)).getTime());
    S.accepted.push({ ...p, accepted: undefined });
    save();
  },
  ics: (v) => { const p = view.proposals.find((x) => x.id === v); if (p) downloadICS(p, S.place && S.place.name); return false; },
  done: (v) => { ui.modal = { type: 'run', id: v, day: C.dayKey(nowDate()) }; },
  'add-run': () => { ui.modal = { type: 'run', day: C.dayKey(nowDate()) }; },
  'run-day': (v) => { ui.modal.day = v; },
  'save-run': () => {
    const km = parseFloat(document.getElementById('runkm').value.replace(',', '.'));
    if (!(km > 0 && km < 300)) return false;
    const [y, mo, da] = ui.modal.day.split('-').map(Number);
    const isToday = ui.modal.day === C.dayKey(nowDate());
    const date = isToday ? nowDate().getTime() : new Date(y, mo - 1, da, 12).getTime();
    S.runs.push({ id: 'm-' + Date.now(), date, km: Math.round(km * 10) / 10, durationSec: 0, source: 'manual' });
    ui.modal = null;
    save();
  },
  close: () => { ui.modal = null; },
  pref: (v) => { const [kind, val] = v.split(':'); S.prefs[kind] = val; save(); },
  meeting: (v) => { S.meetings14 = S.meetings14.includes(v) ? S.meetings14.filter((k) => k !== v) : [...S.meetings14, v]; save(); },
  checkin: (v) => {
    const k = C.dayKey(nowDate());
    const c = S.checkIns[k] || { drank: false, heavy: false, answered: false };
    if (v === 'none') { c.drank = false; c.heavy = false; } else c[v] = !c[v];
    c.answered = true;
    S.checkIns[k] = c;
    save();
  },
  goal: (v) => { S.goal = Math.min(7, Math.max(1, S.goal + Number(v))); save(); },
  gust: (v) => { S.thresholds.maxGustKmh = Math.min(40, Math.max(5, S.thresholds.maxGustKmh + Number(v))); save(); },
  rain: (v) => { S.thresholds.maxRainMMH = Math.min(3, Math.max(0, Math.round((S.thresholds.maxRainMMH + Number(v)) * 10) / 10)); save(); },
  refresh: () => { refreshWeather(true); return false; },
  reset: () => { ui.modal = { type: 'reset' }; },
  'reset-ok': () => { S = resetState(); ui.modal = null; ui.step = 0; ui.tab = 'home'; },
};
const placeFrom = () => { const r = ui.results[ui.picked]; return { name: r.name, lat: r.lat, lon: r.lon }; };

root.addEventListener('click', (e) => {
  if (e.target.closest('[data-stop]') && !e.target.closest('[data-action]')) return;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.classList.contains('modal') && e.target !== el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (fn(el.dataset.v || el.dataset.id) !== false) render();
});
root.addEventListener('input', (e) => {
  if (e.target.id === 'q') startPlaceSearch(e.target.value);
  if (e.target.id === 'runkm' && ui.modal) ui.modal.km = e.target.value;
});
root.addEventListener('change', async (e) => {
  if (e.target.id !== 'restore' || !e.target.files[0]) return;
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!data || !Array.isArray(data.runs)) throw new Error('format');
    const known = new Set(S.runs.map((r) => r.id));
    const fresh = data.runs.filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.date) && r.km > 0 && !known.has(r.id));
    S.runs = S.runs.concat(fresh);
    if (Number.isInteger(data.goal)) S.goal = Math.min(7, Math.max(1, data.goal));
    if (data.prefs) S.prefs = { ...S.prefs, ...data.prefs };
    if (data.thresholds) S.thresholds = { ...S.thresholds, ...data.thresholds };
    if (data.place && !S.place) S.place = data.place;
    ui.info = `${fresh.length} course${fresh.length > 1 ? 's' : ''} restaurée${fresh.length > 1 ? 's' : ''}.`;
    save();
  } catch {
    ui.info = "Ce fichier n'est pas une sauvegarde valide. Rien n'a été modifié.";
  }
  render();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refreshWeather(); } });
setInterval(() => { if (!document.hidden && !ui.modal && document.activeElement.tagName !== 'INPUT') render(); }, 60000);

if ('serviceWorker' in navigator && !DEMO && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
refreshWeather();
