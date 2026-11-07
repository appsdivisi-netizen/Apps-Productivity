// Antarmuka penyimpanan sederhana di atas Cloudflare Workers KV.
// "prim" = {get(key,type), put(key,value), del(key)}; versi data disimpan di key kecil "data-ver".
export function makeStore(p) {
  return {
    get: (k, o = {}) => p.get(k, o.type || "text"),
    setJSON: (k, v) => p.put(k, JSON.stringify(v)),
    async set(k, v) { await p.put(k, v); if (k === "data") await p.put("data-ver", Date.now().toString(36) + "-" + v.byteLength); },
    async delete(k) { await p.del(k); if (k === "data") await p.del("data-ver"); },
    async getMetadata(k) { if (k !== "data") return null; const v = await p.get("data-ver", "text"); return v ? { etag: v } : null; },
  };
}
export const kvPrim = (kv) => ({
  get: (k, t) => kv.get(k, t === "json" ? "json" : t === "arrayBuffer" ? "arrayBuffer" : "text"),
  put: (k, v) => kv.put(k, v),
  del: (k) => kv.delete(k),
});
