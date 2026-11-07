// Backend Cloudflare Pages (Pages Functions + Workers KV). Route /api/*:
//   GET /auth, /access, /status, /settings, /data, /coda, /history, /pin
//   PUT /data, /settings, /coda, /pin    POST /coda/test, /coda/sync, /history/restore
import { makeStore, kvPrim } from "../../lib/store.mjs";
import { setEnv, parseTarget, getConfig, getStatus, patchStatus, publicConfig, probe, isRunning, getHistory, pushHistory, MAX_BYTES } from "../../lib/coda.mjs";
import { pinGate, viewGate, getAuth, adminMatches, viewState, viewMatches, hashPin } from "../../lib/auth.mjs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const envLabel = (env, url) => env.ENV_LABEL || (url.hostname.endsWith(".pages.dev") && url.hostname.split(".").length > 3 ? "uji" : "");

export async function onRequest({ request: req, env }) {
  setEnv(env);
  if (!env.KV) return json({ error: "Binding KV belum dipasang di Cloudflare Pages (Settings > Bindings > KV namespace, nama: KV)." }, 500);
  const kv = env.KV, store = makeStore(kvPrim(kv)), url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, ""), m = req.method;
  const guard = async () => { const g = await pinGate(store, req, env); return g ? json({ error: g.error }, g.status) : null; };
  const readGate = async () => { const g = await viewGate(store, req, env); return g ? json({ error: g.error, needView: true }, g.status) : null; };
  try {
    if (route === "auth" && m === "GET") return (await guard()) || json({ ok: true });
    if (route === "access" && m === "GET") return (await readGate()) || json({ ok: true, required: viewState(await getAuth(store), env).on });

    if (route === "data") {
      if (m === "GET") {
        const denied = await readGate();
        if (denied) return denied;
        const [body, ver] = await Promise.all([kv.get("data", "stream"), kv.get("data-ver")]);
        if (!body) return json({ error: "Belum ada data." }, 404);
        return new Response(body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-data-version": ver || "" } });
      }
      if (m === "PUT") {
        const denied = await guard();
        if (denied) return denied;
        const body = await req.arrayBuffer();
        if (body.byteLength > MAX_BYTES) return json({ error: "Data terlalu besar (maks ~20 MB terkompres)." }, 413);
        const u = new Uint8Array(body);
        if (u.length < 20 || u[0] !== 0x1f || u[1] !== 0x8b) return json({ error: "Format data tidak valid (harus gzip)." }, 400);
        let meta = {};
        try { meta = JSON.parse(decodeURIComponent(req.headers.get("x-data-info") || "{}")) || {}; } catch {}
        const info = { src: String(meta.src || "").slice(0, 200), cut: String(meta.cut || "").slice(0, 40), rows: +meta.rows || 0, via: "upload", at: Date.now() };
        const prev = await kv.get("data", "arrayBuffer");
        if (prev) await pushHistory(store, prev, "sebelum upload data baru");
        await store.set("data", body);
        await store.setJSON("data-info", info);
        return json({ ok: true });
      }
    }

    if (route === "settings") {
      if (m === "GET") {
        const denied = await readGate();
        if (denied) return denied;
        return json((await store.get("settings", { type: "json" })) || {});
      }
      if (m === "PUT") {
        const denied = await guard();
        if (denied) return denied;
        const b = await req.json().catch(() => null);
        if (!b || !Array.isArray(b.master) || !Array.isArray(b.exc)) return json({ error: "Format pengaturan tidak valid." }, 400);
        await store.setJSON("settings", { master: b.master, exc: b.exc, at: Date.now() });
        return json({ ok: true });
      }
    }

    if (route === "status" && m === "GET") {
      const [meta, st, cfg] = await Promise.all([store.getMetadata("data"), getStatus(store), getConfig(store)]);
      return json({ version: meta ? meta.etag : null, env: envLabel(env, url),
        coda: { state: st.state || "", lastOkAt: st.lastOkAt || 0, rows: st.rows || 0, enabled: !!cfg.enabled, intervalMin: cfg.intervalMin || 60 } });
    }

    if (route === "coda" && m === "GET") {
      const denied = await guard();
      if (denied) return denied;
      return json({ ...publicConfig(await getConfig(store)), status: await getStatus(store) });
    }
    if (route === "coda" && m === "PUT") {
      const denied = await guard();
      if (denied) return denied;
      const b = await req.json().catch(() => null);
      if (!b) return json({ error: "Format pengaturan tidak valid." }, 400);
      const p = parseTarget(b.link);
      if (!p.docId) return json({ error: "Link atau ID dokumen Coda tidak dikenali." }, 400);
      const table = String(b.table || "").trim() || p.table;
      if (!table) return json({ error: "Nama atau ID tabel Coda belum diisi." }, 400);
      const next = { ...(await getConfig(store)), link: String(b.link || "").trim(), docId: p.docId, table,
        enabled: !!b.enabled, intervalMin: [15, 30, 60, 360, 1440].includes(+b.intervalMin) ? +b.intervalMin : 60 };
      if (typeof b.token === "string" && b.token.trim()) next.token = b.token.trim();
      if (b.clearToken) delete next.token;
      await store.setJSON("coda-config", next);
      return json({ ok: true, config: publicConfig(next) });
    }
    if (route === "coda/test" && m === "POST") {
      const denied = await guard();
      if (denied) return denied;
      const cfg = await getConfig(store), token = cfg.token || env.CODA_API_TOKEN;
      if (!cfg.docId || !cfg.table || !token) return json({ error: "Isi link, tabel, dan token Coda dulu, lalu Simpan." }, 400);
      try { return json({ ok: true, ...(await probe(cfg, token)) }); }
      catch (e) { return json({ error: e.message || String(e) }, 400); }
    }
    if (route === "coda/sync" && m === "POST") {
      const denied = await guard();
      if (denied) return denied;
      const cfg = await getConfig(store), st = await getStatus(store);
      if (!cfg.docId || !cfg.table || !(cfg.token || env.CODA_API_TOKEN)) return json({ error: "Integrasi Coda belum lengkap (link, tabel, token)." }, 400);
      if (!env.GH_REPO || !env.GH_TOKEN) return json({ error: "Tombol sinkron butuh variabel GH_REPO dan GH_TOKEN di Cloudflare (lihat SETUP-CLOUDFLARE.md). Sinkron otomatis tetap berjalan lewat GitHub Actions." }, 400);
      if (isRunning(st)) return json({ error: "Sinkron sedang berjalan. Tunggu sebentar." }, 409);
      await patchStatus(store, { state: "running", lastTryAt: Date.now() });
      const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/coda-sync.yml/dispatches`, {
        method: "POST",
        headers: { Authorization: "Bearer " + env.GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "monitoring-productivity-apps", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ ref: env.GH_REF || "main" }),
      });
      if (r.status >= 300) {
        await patchStatus(store, { state: "error", lastError: "Gagal memicu GitHub Actions (HTTP " + r.status + ").", lastErrorAt: Date.now() });
        return json({ error: "Gagal memicu GitHub Actions (HTTP " + r.status + "). Periksa GH_REPO, GH_TOKEN, dan nama branch." }, 502);
      }
      return json({ ok: true, started: true });
    }

    if (route === "history" && m === "GET") {
      const denied = await guard();
      if (denied) return denied;
      return json({ items: await getHistory(store) });
    }
    if (route === "history/restore" && m === "POST") {
      const denied = await guard();
      if (denied) return denied;
      const b = await req.json().catch(() => null), id = String((b && b.id) || "");
      const e = (await getHistory(store)).find((x) => x.id === id);
      if (!e) return json({ error: "Versi tidak ditemukan." }, 404);
      const bytes = await kv.get("hist-" + id, "arrayBuffer");
      if (!bytes) return json({ error: "Berkas versi tidak ditemukan." }, 404);
      const cur = await kv.get("data", "arrayBuffer");
      if (cur) await pushHistory(store, cur, "sebelum pemulihan versi");
      await store.set("data", bytes);
      await store.setJSON("data-info", { src: e.src || "", cut: e.cut || "", via: e.via || "", rows: e.rows || 0, at: Date.now() });
      return json({ ok: true });
    }

    if (route === "pin" && m === "GET") {
      const denied = await guard();
      if (denied) return denied;
      const a = await getAuth(store), vs = viewState(a, env), reset = !!env.ADMIN_PIN_RESET;
      return json({ admin: a.admin && !reset ? "aplikasi" : "variabel", adminAt: (a.admin && a.admin.at) || 0, reset,
        view: vs.on ? (vs.rec ? "aplikasi" : "variabel") : a.view && a.view.off ? "dimatikan" : "tidak aktif", viewOn: vs.on, viewAt: (a.view && a.view.at) || 0 });
    }
    if (route === "pin" && m === "PUT") {
      const denied = await guard();
      if (denied) return denied;
      const b = (await req.json().catch(() => null)) || {}, a = await getAuth(store);
      if (b.type === "view" && b.off) { a.view = { off: true, at: Date.now() }; await store.setJSON("auth", a); return json({ ok: true }); }
      const pin = String(b.pin || "");
      if (pin.length < 6 || pin.length > 64) return json({ error: "PIN minimal 6 karakter (maksimal 64)." }, 400);
      if (b.type === "view") {
        if (await adminMatches(pin, a, env)) return json({ error: "PIN akses tidak boleh sama dengan PIN admin." }, 400);
        a.view = { ...(await hashPin(pin)), at: Date.now() };
      } else if (b.type === "admin") {
        if (!(await adminMatches(String(b.current || ""), a, env))) return json({ error: "PIN admin saat ini salah." }, 401);
        const vs = viewState(a, env);
        if (vs.on && (await viewMatches(pin, vs))) return json({ error: "PIN admin tidak boleh sama dengan PIN akses." }, 400);
        a.admin = { ...(await hashPin(pin)), at: Date.now() };
      } else return json({ error: "Jenis PIN tidak dikenal." }, 400);
      await store.setJSON("auth", a);
      return json({ ok: true, warn: b.type === "admin" && env.ADMIN_PIN_RESET ? "ADMIN_PIN_RESET di Cloudflare masih aktif, jadi PIN baru belum berlaku. Hapus variabel itu lalu deploy ulang." : "" });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message ? e.message : e) }, 500);
  }
}
