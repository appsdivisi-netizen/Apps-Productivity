// Penyimpanan data bersama untuk Monitoring Productivity Apps.
// Routes (path /api/*):
//   GET    /api/data      publik   -> data Excel terkompres (gzip), 404 jika kosong
//   PUT    /api/data      admin    -> simpan data baru (menimpa yang lama)
//   DELETE /api/data      admin    -> hapus data
//   GET    /api/settings  publik   -> { master, exc }
//   PUT    /api/settings  admin    -> simpan Master PIC & pengecualian
//   GET    /api/auth      admin    -> cek PIN
//   GET    /api/status    publik   -> { version, coda } (dipakai browser untuk deteksi data baru)
//   GET/PUT /api/coda     admin    -> pengaturan integrasi Coda (token TIDAK pernah dikembalikan)
//   POST   /api/coda/test admin    -> tes koneksi ke Coda
//   POST   /api/coda/sync admin    -> picu sinkron sekarang (background function)
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";
import { parseTarget, getConfig, getStatus, patchStatus, publicConfig, probe, isRunning } from "../lib/coda.mjs";

export const config = { path: "/api/*" };

const MAX_BYTES = 5.8 * 1024 * 1024; // batas payload function Netlify = 6 MB

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// true = PIN benar, false = salah, null = ADMIN_PIN belum diset di Netlify
function checkPin(req) {
  const real = process.env.ADMIN_PIN;
  if (!real) return null;
  const given = req.headers.get("x-admin-pin") || "";
  const h = (v) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(given), h(real));
}

function guard(req) {
  const ok = checkPin(req);
  if (ok === null) return json({ error: "ADMIN_PIN belum diset di Netlify (Site configuration > Environment variables)." }, 500);
  if (!ok) return json({ error: "PIN salah." }, 401);
  return null;
}

async function gunzipJson(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const store = getStore("productivity-apps");
  const m = req.method;

  try {
    if (route === "auth" && m === "GET") {
      return guard(req) || json({ ok: true });
    }

    if (route === "data") {
      if (m === "GET") {
        const got = await store.getWithMetadata("data", { type: "arrayBuffer" });
        if (!got || !got.data) return json({ error: "Belum ada data." }, 404);
        return new Response(got.data, {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-data-version": got.etag || "" },
        });
      }
      if (m === "PUT" || m === "DELETE") {
        const denied = guard(req);
        if (denied) return denied;

        let body = null;
        if (m === "PUT") {
          body = await req.arrayBuffer();
          if (body.byteLength > MAX_BYTES) return json({ error: "Data terlalu besar (maks ~5,8 MB terkompres)." }, 413);
          let parsed;
          try { parsed = await gunzipJson(body); } catch { return json({ error: "Format data tidak valid." }, 400); }
          if (!Array.isArray(parsed.cols) || !Array.isArray(parsed.aoa) || !parsed.aoa.length)
            return json({ error: "Isi data tidak valid (cols/aoa kosong)." }, 400);
        }

        // simpan 1 versi sebelumnya sebagai cadangan di server
        const prev = await store.get("data", { type: "arrayBuffer" });
        if (prev) await store.set("data-prev", prev);

        if (m === "PUT") await store.set("data", body);
        else await store.delete("data");
        return json({ ok: true });
      }
    }

    if (route === "settings") {
      if (m === "GET") return json((await store.get("settings", { type: "json" })) || {});
      if (m === "PUT") {
        const denied = guard(req);
        if (denied) return denied;
        const b = await req.json().catch(() => null);
        if (!b || !Array.isArray(b.master) || !Array.isArray(b.exc)) return json({ error: "Format pengaturan tidak valid." }, 400);
        await store.setJSON("settings", { master: b.master, exc: b.exc, at: Date.now() });
        return json({ ok: true });
      }
    }

    if (route === "status" && m === "GET") {
      const meta = await store.getMetadata("data");
      const st = await getStatus(store);
      return json({ version: meta ? meta.etag : null, coda: { state: st.state || "", lastOkAt: st.lastOkAt || 0, rows: st.rows || 0 } });
    }

    if (route === "coda" && m === "GET") {
      const denied = guard(req);
      if (denied) return denied;
      return json({ ...publicConfig(await getConfig(store)), status: await getStatus(store) });
    }
    if (route === "coda" && m === "PUT") {
      const denied = guard(req);
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
      const denied = guard(req);
      if (denied) return denied;
      const cfg = await getConfig(store), token = cfg.token || process.env.CODA_API_TOKEN;
      if (!cfg.docId || !cfg.table || !token) return json({ error: "Isi link, tabel, dan token Coda dulu, lalu Simpan." }, 400);
      try { return json({ ok: true, ...(await probe(cfg, token)) }); }
      catch (e) { return json({ error: e.message || String(e) }, 400); }
    }
    if (route === "coda/sync" && m === "POST") {
      const denied = guard(req);
      if (denied) return denied;
      const cfg = await getConfig(store), st = await getStatus(store);
      if (!cfg.docId || !cfg.table || !(cfg.token || process.env.CODA_API_TOKEN)) return json({ error: "Integrasi Coda belum lengkap (link, tabel, token)." }, 400);
      if (isRunning(st)) return json({ error: "Sinkron sedang berjalan. Tunggu sebentar." }, 409);
      await patchStatus(store, { state: "running", lastTryAt: Date.now() });
      const r = await fetch(new URL(req.url).origin + "/.netlify/functions/coda-sync-background", { method: "POST", headers: { "x-admin-pin": req.headers.get("x-admin-pin") || "" } });
      if (r.status >= 300) {
        await patchStatus(store, { state: "error", lastError: "Gagal memicu sinkron (HTTP " + r.status + ").", lastErrorAt: Date.now() });
        return json({ error: "Gagal memicu sinkron (HTTP " + r.status + ")." }, 502);
      }
      return json({ ok: true, started: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message ? e.message : e) }, 500);
  }
};
