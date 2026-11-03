// Background function (maks 15 menit): menarik semua baris dari Coda. Dipanggil oleh api.mjs (tombol Sinkron) dan coda-scheduled.mjs.
import { getStore } from "@netlify/blobs";
import { checkPin, runSync } from "../lib/coda.mjs";

export default async (req) => {
  if (req.method !== "POST" || checkPin(req) !== true) return new Response(null, { status: 202 });
  await runSync(getStore("productivity-apps"));
  return new Response(null, { status: 202 });
};
