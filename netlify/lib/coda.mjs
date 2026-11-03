// Sinkron data dari Coda API ke penyimpanan dashboard (dipakai api.mjs, coda-sync-background.mjs, coda-scheduled.mjs).
import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_BYTES = 5.8 * 1024 * 1024; // batas respons function Netlify = 6 MB
const RUN_STALE_MS = 20 * 60 * 1000;
const base = () => (process.env.CODA_API_BASE || "https://coda.io/apis/v1").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function checkPin(req) {
  const real = process.env.ADMIN_PIN;
  if (!real) return null;
  const h = (v) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(req.headers.get("x-admin-pin") || ""), h(real));
}

// Terima: link browser Coda, link API (/docs/ID/tables/NAMA), atau ID dokumen saja.
export function parseTarget(input) {
  const s = String(input || "").trim();
  let docId = "", table = "", m;
  if ((m = s.match(/\/docs\/([A-Za-z0-9_-]+)/))) docId = m[1];
  else if ((m = s.match(/\/d\/([^/?#]+)/))) { const seg = m[1], i = seg.lastIndexOf("_d"); docId = i >= 0 ? seg.slice(i + 2) : seg; }
  else if (/^[A-Za-z0-9_-]{6,}$/.test(s)) docId = s;
  if ((m = s.match(/\/tables\/([^/?#]+)/))) { try { table = decodeURIComponent(m[1]); } catch { table = m[1]; } }
  return { docId, table };
}

export const getConfig = async (store) => (await store.get("coda-config", { type: "json" })) || {};
export const getStatus = async (store) => (await store.get("coda-status", { type: "json" })) || {};
export async function patchStatus(store, p) {
  const n = { ...(await getStatus(store)), ...p };
  await store.setJSON("coda-status", n);
  return n;
}
export const publicConfig = (c) => ({
  link: c.link || "", docId: c.docId || "", table: c.table || "",
  enabled: !!c.enabled, intervalMin: c.intervalMin || 60,
  hasToken: !!c.token, tokenHint: c.token ? "••••" + c.token.slice(-4) : "",
  envToken: !!process.env.CODA_API_TOKEN,
}); // token TIDAK pernah dikembalikan

export function dueNow(cfg, st) {
  if (!cfg.enabled || !cfg.docId || !cfg.table || !(cfg.token || process.env.CODA_API_TOKEN)) return false;
  if (st.state === "running" && Date.now() - (st.lastTryAt || 0) < RUN_STALE_MS) return false;
  return Date.now() - (st.lastTryAt || 0) >= (cfg.intervalMin || 60) * 60000 - 30000;
}
export const isRunning = (st) => st.state === "running" && Date.now() - (st.lastTryAt || 0) < RUN_STALE_MS;

async function codaGet(path, token) {
  const unit = Number(process.env.CODA_RETRY_UNIT_MS ?? 1000);
  let lastErr;
  for (let i = 0; i < 5; i++) {
    let r;
    try { r = await fetch(base() + path, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { lastErr = e; await sleep(unit * (i + 1)); continue; }
    if (r.status === 429 || r.status >= 500) {
      lastErr = new Error("Coda " + r.status);
      await sleep(Math.min(Number(r.headers.get("retry-after")) || 2 * (i + 1), 20) * unit);
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new Error("Token Coda ditolak (" + r.status + "). Periksa token dan akses akun ke dokumen.");
    if (r.status === 404) throw new Error("Dokumen atau tabel Coda tidak ditemukan (404). Periksa link dan nama tabel.");
    if (!r.ok) throw new Error("Coda API " + r.status);
    return r.json();
  }
  throw new Error("Gagal menghubungi Coda: " + ((lastErr && lastErr.message) || lastErr));
}

const ISO_MID = /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|[+-]\d{2}:?\d{2})$/;
function norm(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(norm).filter((x) => x !== "").join(", ");
  if (typeof v === "object") return norm(v.name ?? v.displayValue ?? v.url ?? JSON.stringify(v));
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return ISO_MID.test(v.trim()) ? v.trim().slice(0, 10) : v;
  return v;
}

const paths = ({ docId, table }) => `/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(table)}`;

export async function probe(cfg, token) {
  const p = paths(cfg);
  const info = await codaGet(p, token);
  const cols = await codaGet(p + "/columns?limit=200", token);
  return { table: info.name || cfg.table, cols: (cols.items || []).length, rows: info.rowCount };
}

export async function pullTable(cfg, token) {
  const p = paths(cfg);
  const info = await codaGet(p, token);
  let cols = [], tok = "";
  try {
    do {
      const j = await codaGet(`${p}/columns?limit=200${tok ? "&pageToken=" + encodeURIComponent(tok) : ""}`, token);
      cols.push(...(j.items || []).map((c) => c.name));
      tok = j.nextPageToken || "";
    } while (tok);
  } catch (e) { if (/ditolak|tidak ditemukan/.test(e.message)) throw e; cols = []; }
  const rows = []; tok = ""; let pages = 0;
  do {
    const j = await codaGet(`${p}/rows?useColumnNames=true&valueFormat=simple&limit=500${tok ? "&pageToken=" + encodeURIComponent(tok) : ""}`, token);
    for (const it of j.items || []) rows.push(it.values || {});
    tok = j.nextPageToken || "";
    if (++pages > 400) throw new Error("Terlalu banyak halaman dari Coda (>400).");
  } while (tok);
  if (!cols.length && rows.length) { const seen = new Set(); for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) seen.add(k); cols = [...seen]; }
  return { name: info.name || cfg.table, cols, aoa: rows.map((r) => cols.map((c) => norm(r[c]))) };
}

const gz = (obj) => new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
export async function gunzipJson(bytes) {
  return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
}
function isoWeekWIB() {
  const n = new Date(Date.now() + 7 * 3600e3), t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  return { y, w: Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7) };
}

export async function runSync(store) {
  const cfg = await getConfig(store), token = cfg.token || process.env.CODA_API_TOKEN, t0 = Date.now();
  if (!cfg.docId || !cfg.table || !token)
    return patchStatus(store, { state: "error", lastError: "Belum lengkap: link, nama tabel, atau token Coda belum diisi.", lastErrorAt: t0 });
  await patchStatus(store, { state: "running", lastTryAt: t0 });
  try {
    const { name, cols, aoa } = await pullTable(cfg, token);
    if (!aoa.length) throw new Error("Tabel Coda kosong (0 baris).");
    const prevBytes = await store.get("data", { type: "arrayBuffer" });
    if (prevBytes) {
      let prev = null;
      try { prev = await gunzipJson(prevBytes); } catch {}
      if (prev && Array.isArray(prev.aoa) && aoa.length < prev.aoa.length * 0.5)
        throw new Error(`Jumlah baris dari Coda (${aoa.length}) turun lebih dari 50% dibanding data sekarang (${prev.aoa.length}). Sinkron dibatalkan supaya data aman. Cek tabel/filter di Coda, atau upload Excel manual.`);
    }
    const { w, y } = isoWeekWIB();
    const body = await gz({ cols, aoa, src: "Coda · " + name, cut: `W.${w}-${y}`, at: Date.now(), via: "coda" });
    if (body.byteLength > MAX_BYTES) throw new Error("Data dari Coda terlalu besar (maks ~5,8 MB terkompres).");
    if (prevBytes) await store.set("data-prev", prevBytes);
    await store.set("data", body);
    return patchStatus(store, { state: "ok", lastOkAt: Date.now(), lastError: "", rows: aoa.length, cols: cols.length, table: name, ms: Date.now() - t0 });
  } catch (e) {
    return patchStatus(store, { state: "error", lastError: String((e && e.message) || e), lastErrorAt: Date.now() });
  }
}
