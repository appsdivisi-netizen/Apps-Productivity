// PIN admin / PIN akses: hash tersimpan di KV ("auth"), variabel Cloudflare jadi nilai awal/cadangan.
// Hanya memakai Web Crypto (cocok untuk batas CPU Workers gratis).
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
const sha = async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(v))));
export async function eq(a, b) {
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const ITER = 10000;
async function pbkdf(pin, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, k, 256));
}
export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: hex(salt), hash: hex(await pbkdf(pin, salt)) };
}
async function verifyHash(pin, rec) {
  try {
    const h = await pbkdf(pin, unhex(rec.salt)), b = unhex(rec.hash);
    let d = h.length ^ b.length; for (let i = 0; i < h.length; i++) d |= h[i] ^ (b[i] || 0);
    return d === 0;
  } catch { return false; }
}
export const getAuth = async (store) => (await store.get("auth", { type: "json" })) || {};
const adminRec = (auth, env) => (auth.admin && !env.ADMIN_PIN_RESET ? auth.admin : null);
export async function adminMatches(pin, auth, env) {
  if (!pin) return false;
  const rec = adminRec(auth, env);
  if (rec) return verifyHash(pin, rec);
  return !!env.ADMIN_PIN && eq(pin, env.ADMIN_PIN);
}
export function viewState(auth, env) {
  if (auth.view && auth.view.off) return { on: false };
  if (auth.view && auth.view.hash) return { on: true, rec: auth.view };
  return env.VIEW_PIN ? { on: true, envPin: env.VIEW_PIN } : { on: false };
}
export const viewMatches = (pin, vs) => (!pin || !vs.on ? Promise.resolve(false) : vs.rec ? verifyHash(pin, vs.rec) : eq(pin, vs.envPin));

// ---- Pembatasan percobaan: 5x PIN salah -> terkunci 15 menit per alamat IP ----
const LOCK_MAX = 5, LOCK_MS = 15 * 60e3;
const ipOf = (req) => req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "lokal";
async function lockPut(store, m) {
  const now = Date.now();
  for (const k of Object.keys(m)) if ((m[k].lock || 0) < now && now - m[k].first > LOCK_MS) delete m[k];
  await store.setJSON("pin-fail", m);
}
async function gateWith(store, req, matches, sent) {
  const ip = ipOf(req), m = (await store.get("pin-fail", { type: "json" })) || {}, e = m[ip], now = Date.now();
  if (e && e.lock && e.lock > now) return { status: 429, error: `Terlalu banyak percobaan salah. Coba lagi dalam ${Math.ceil((e.lock - now) / 60000)} menit.` };
  if (matches) { if (e) { delete m[ip]; await lockPut(store, m); } return null; }
  if (sent) {
    const f = e && now - e.first < LOCK_MS ? e : { n: 0, first: now };
    f.n++;
    if (f.n >= LOCK_MAX) { f.lock = now + LOCK_MS; f.n = 0; f.first = now; }
    m[ip] = f; await lockPut(store, m);
  }
  return { status: 401, error: "PIN salah." };
}
// null = lolos, atau { status, error }
export async function pinGate(store, req, env) {
  const auth = await getAuth(store);
  if (!env.ADMIN_PIN && !adminRec(auth, env)) return { status: 500, error: "ADMIN_PIN belum diset di Cloudflare (Settings > Variables and Secrets)." };
  const sent = req.headers.get("x-admin-pin") || "";
  return gateWith(store, req, sent ? await adminMatches(sent, auth, env) : false, !!sent);
}
// Akses baca (opsional): aktif bila PIN akses diatur. PIN admin otomatis boleh membaca.
export async function viewGate(store, req, env) {
  const auth = await getAuth(store), vs = viewState(auth, env);
  if (!vs.on) return null;
  const vp = req.headers.get("x-view-pin") || "", ap = req.headers.get("x-admin-pin") || "";
  let ok = vp ? await viewMatches(vp, vs) : false;
  if (!ok && ap) ok = await adminMatches(ap, auth, env);
  const r = await gateWith(store, req, ok, !!(vp || ap));
  if (!r) return null;
  return { status: r.status, needView: true, error: r.status === 401 ? (vp || ap ? "PIN akses salah." : "Akses dibatasi. Masukkan PIN akses.") : r.error };
}
