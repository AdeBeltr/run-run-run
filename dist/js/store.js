import { DEFAULT_THRESHOLDS } from './core.js';

const KEY = 'rrr:v1';
const defaults = () => ({
  installDate: Date.now(),
  onboardingDone: false,
  place: null, // { name, lat, lon }
  goal: 2, // runs par semaine visés
  thresholds: { ...DEFAULT_THRESHOLDS },
  runs: [], // { id, date(ms), km, durationSec, source: 'health' | 'manual' }
  meetings14: [], // clés « yyyy-MM-dd »
  checkIns: {}, // clé jour → { drank, heavy, answered }
  accepted: [], // propositions acceptées
  forecast: [], // [{ t, precip, gust, temp, code }]
  forecastFetchedAt: null,
  weatherError: false,
});

export function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...defaults(), ...raw, thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds || {}) } };
  } catch { /* stockage indisponible ou corrompu : on repart de zéro */ }
  return defaults();
}

export function saveState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota ou mode privé */ }
}

export function resetState() {
  try { localStorage.removeItem(KEY); } catch { /* rien */ }
  return defaults();
}
