// Penyimpanan data bersama untuk Monitoring Productivity Apps.
// Routes (path /api/*):
//   GET    /api/data      publik   -> data Excel terkompres (gzip), 404 jika kosong
//   PUT    /api/data      admin    -> simpan data baru (menimpa yang lama)
//   DELETE /api/data      admin    -> hapus data
//   GET    /api/settings  publik   -> { master, exc }
//   PUT    /api/settings  admin    -> simpan Master PIC & pengecualian
//   GET    /api/auth      admin    -> cek PIN
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

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
        const bytes = await store.get("data", { type: "arrayBuffer" });
        if (!bytes) return json({ error: "Belum ada data." }, 404);
        return new Response(bytes, {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
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

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message ? e.message : e) }, 500);
  }
};
