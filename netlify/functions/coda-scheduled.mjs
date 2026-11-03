// Cek tiap 15 menit; kalau sudah waktunya (sesuai interval di Master), picu sinkron Coda.
import { getStore } from "@netlify/blobs";
import { getConfig, getStatus, dueNow, patchStatus } from "../lib/coda.mjs";

export const config = { schedule: "*/15 * * * *" };

export default async () => {
  const store = getStore("productivity-apps");
  const [cfg, st] = await Promise.all([getConfig(store), getStatus(store)]);
  if (!dueNow(cfg, st)) return;
  const origin = process.env.URL || process.env.DEPLOY_URL, pin = process.env.ADMIN_PIN;
  if (!origin || !pin) return;
  await patchStatus(store, { state: "running", lastTryAt: Date.now() });
  const r = await fetch(origin + "/.netlify/functions/coda-sync-background", { method: "POST", headers: { "x-admin-pin": pin } });
  if (r.status >= 300) await patchStatus(store, { state: "error", lastError: "Gagal memicu sinkron (HTTP " + r.status + ").", lastErrorAt: Date.now() });
};
