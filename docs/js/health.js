// Import d'un export Apple Santé (export.zip ou export.xml), lu en flux sur l'appareil.
const KM = { km: 1, m: 0.001, mi: 1.609344 };

function attrsOf(s) {
  const o = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}

function toDate(s) {
  // « 2024-11-03 12:10:05 +0100 » → ISO
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s || '');
  return m ? new Date(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`) : new Date(NaN);
}

/** Transforme un <Workout …> en course, ou null si ce n'est pas une course à pied. */
export function workoutToRun(attrString, inner) {
  const a = attrsOf(attrString);
  if (a.workoutActivityType !== 'HKWorkoutActivityTypeRunning') return null;
  let dist = parseFloat(a.totalDistance), unit = a.totalDistanceUnit;
  if (!Number.isFinite(dist) && inner) {
    const m = /<WorkoutStatistics\b[^>]*type="HKQuantityTypeIdentifierDistanceWalkingRunning"[^>]*>/.exec(inner);
    if (m) { const s = attrsOf(m[0]); dist = parseFloat(s.sum); unit = s.unit; }
  }
  if (!Number.isFinite(dist)) return null;
  const km = dist * (KM[unit] ?? 1);
  const start = toDate(a.startDate);
  if (Number.isNaN(start.getTime()) || !(km > 0)) return null;
  const dur = parseFloat(a.duration);
  const durationSec = Number.isFinite(dur) ? dur * (a.durationUnit === 'min' ? 60 : a.durationUnit === 'hr' ? 3600 : 1) : 0;
  return { id: `h-${start.getTime()}-${km.toFixed(2)}`, date: start.getTime(), km: Math.round(km * 100) / 100, durationSec, source: 'health' };
}

/** Extrait les courses complètes d'un tampon de texte ; renvoie aussi le reste à conserver. */
export function drain(buf) {
  const runs = [];
  let pos = 0;
  for (;;) {
    const i = buf.indexOf('<Workout ', pos);
    if (i < 0) { pos = Math.max(pos, buf.length - 9); break; }
    const gt = buf.indexOf('>', i);
    if (gt < 0) { pos = i; break; }
    const attrs = buf.slice(i + 9, gt);
    if (attrs.endsWith('/')) { const r = workoutToRun(attrs, ''); if (r) runs.push(r); pos = gt + 1; continue; }
    const close = buf.indexOf('</Workout>', gt);
    if (close < 0) { pos = i; break; }
    const r = workoutToRun(attrs, buf.slice(gt + 1, close));
    if (r) runs.push(r);
    pos = close + 10;
  }
  return { runs, rest: buf.slice(pos) };
}

async function zipEntryStream(file) {
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557), file.size).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let e = tail.length - 22;
  while (e >= 0 && tv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip illisible');
  const cdSize = tv.getUint32(e + 12, true), cdOff = tv.getUint32(e + 16, true);
  if (cdOff === 0xffffffff) throw new Error('zip trop volumineux (zip64) : décompresse-le et choisis export.xml');
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dv = new DataView(cd.buffer);
  let p = 0;
  while (p + 46 <= cd.length && dv.getUint32(p, true) === 0x02014b50) {
    const method = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.slice(p + 46, p + 46 + nl));
    if (/(^|\/)export\.xml$/.test(name)) {
      const lh = new DataView(await file.slice(off, off + 30).arrayBuffer());
      const start = off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      let stream = file.slice(start, start + comp).stream();
      if (method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
      else if (method !== 0) throw new Error('compression non gérée');
      return stream;
    }
    p += 46 + nl + el + cl;
  }
  throw new Error("export.xml introuvable dans le zip");
}

/** Lit le fichier choisi et renvoie les courses trouvées. */
export async function importFromFile(file, onProgress = () => {}) {
  const raw = /\.zip$/i.test(file.name) ? await zipEntryStream(file) : file.stream();
  const reader = raw.pipeThrough(new TextDecoderStream()).getReader();
  const all = new Map();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    const { runs, rest } = drain(buf);
    buf = rest;
    for (const r of runs) all.set(r.id, r);
    onProgress(all.size);
    if (done) break;
  }
  return [...all.values()];
}
