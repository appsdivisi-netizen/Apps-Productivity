// Akses Workers KV lewat REST API Cloudflare (dipakai GitHub Actions untuk sinkron Coda).
export function restPrim(account, ns, token) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/`;
  const h = { Authorization: "Bearer " + token };
  return {
    async get(k, t) {
      const r = await fetch(base + encodeURIComponent(k), { headers: h });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("KV GET " + r.status);
      return t === "json" ? r.json() : t === "arrayBuffer" ? r.arrayBuffer() : r.text();
    },
    async put(k, v) {
      const r = await fetch(base + encodeURIComponent(k), { method: "PUT", headers: { ...h, "content-type": "application/octet-stream" }, body: v });
      if (!r.ok) throw new Error("KV PUT " + r.status + " " + (await r.text()).slice(0, 200));
    },
    async del(k) {
      const r = await fetch(base + encodeURIComponent(k), { method: "DELETE", headers: h });
      if (!r.ok && r.status !== 404) throw new Error("KV DELETE " + r.status);
    },
  };
}
