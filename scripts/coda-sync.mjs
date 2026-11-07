// Dijalankan GitHub Actions: tarik data dari Coda lalu simpan ke Workers KV (di luar batas CPU Workers gratis).
import { makeStore } from "../lib/store.mjs";
import { restPrim } from "../lib/kvrest.mjs";
import { setEnv, getConfig, getStatus, dueNow, runSync } from "../lib/coda.mjs";

setEnv(process.env);
const miss = ["CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_API_TOKEN"].filter((k) => !process.env[k]);
if (miss.length) { console.error("Secret GitHub belum diisi: " + miss.join(", ")); process.exit(1); }
const store = makeStore(restPrim(process.env.CF_ACCOUNT_ID, process.env.CF_KV_NAMESPACE_ID, process.env.CF_API_TOKEN));

if (process.env.GITHUB_EVENT_NAME === "schedule") {
  const [cfg, st] = await Promise.all([getConfig(store), getStatus(store)]);
  if (!dueNow(cfg, st, 10 * 60000)) { console.log("Belum waktunya sinkron, atau integrasi Coda nonaktif."); process.exit(0); }
}
const r = await runSync(store);
console.log(JSON.stringify(r));
process.exit(r.state === "ok" ? 0 : 1);
