// Schacht-Bestellseite — minimaler öffentlicher Server: Bestellseite + Payrexx-Checkout.
// KEINE Kundendaten, KEINE Secrets im Code. Payrexx-Keys kommen aus process.env (Coolify).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8137);

/* ── Payrexx ── (Deal: 3-Monats-Pilot, 150 Kontakte/Monat) */
const PAYREXX_BASE = "https://api.payrexx.com/v1.0";
const PLANS = {
  pilot3: { id: "pilot3", label: "3-Monats-Pilot · auf einmal", netRappen: 242_190, recurring: false },
  monat:  { id: "monat",  label: "Monatlich · 3-Monats-Pilot", netRappen: 89_700, recurring: true },
};
function phpHttpBuildQuery(params, spaceAsPlus = true) {
  const enc = (s) => { const e = encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); return spaceAsPlus ? e.replace(/%20/g, "+") : e; };
  return Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
}
const payrexxSig = (s) => createHmac("sha256", process.env.PAYREXX_API_KEY || "").update(s, "utf8").digest("base64");
async function createPayrexxGateway({ amountRappen, currency, purpose, referenceId, successUrl, cancelUrl, subscription }) {
  const instance = process.env.PAYREXX_INSTANCE;
  if (!instance || !process.env.PAYREXX_API_KEY) throw new Error("Payrexx nicht konfiguriert");
  const b = { amount: Math.round(amountRappen), currency: currency.toUpperCase(), purpose, successRedirectUrl: successUrl, failedRedirectUrl: cancelUrl, cancelRedirectUrl: cancelUrl, referenceId };
  if (subscription) { b.subscriptionState = 1; b.subscriptionInterval = subscription.interval; b.subscriptionPeriod = subscription.period; b.subscriptionCancellationInterval = subscription.cancel; }
  // Globale Regel: KEINE TWINT, nur Abo-/recurring-fähige Zahlarten (Karte + Wallet).
  ["mastercard", "visa", "american_express", "apple_pay", "google_pay"].forEach((m, i) => { b["pm[" + i + "]"] = m; });
  const laf = process.env.PAYREXX_LOOK_AND_FEEL && process.env.PAYREXX_LOOK_AND_FEEL.trim();
  if (laf) b.lookAndFeelProfile = laf;
  const sig = payrexxSig(phpHttpBuildQuery(b, true));
  const finalBody = phpHttpBuildQuery({ ...b, ApiSignature: sig, instance }, false);
  const res = await fetch(`${PAYREXX_BASE}/Gateway/?instance=${encodeURIComponent(instance)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: finalBody });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== "success" || !json.data?.length) throw new Error(`Payrexx HTTP ${res.status}: ${json?.message || "unbekannt"}`);
  const gw = json.data[0];
  if (!gw.link) throw new Error("Payrexx-Antwort ohne Link");
  return { link: gw.link, gatewayId: gw.id };
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".jpg": "image/jpeg" };
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); }); req.on("end", () => r(d)); req.on("error", () => r("")); });
function send(res, code, b, type = "application/json; charset=utf-8") { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache" }); res.end(b); }

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === "/healthz") return send(res, 200, JSON.stringify({ status: "ok" }));
    if (p === "/favicon.ico") { res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" }); return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#fff"/><circle cx="16" cy="16" r="8" fill="#C8102E"/></svg>`); }

    if (p === "/api/checkout" && req.method === "POST") {
      const b = JSON.parse((await body(req)) || "{}");
      const plan = PLANS[b.plan] || PLANS.pilot3;
      const country = String(b.country || "DE").toUpperCase();
      const zoneCh = country === "CH" || country === "LI";
      const amount = zoneCh ? Math.round(plan.netRappen * 1.081) : plan.netRappen; // DE/EU B2B = Reverse Charge → netto
      const host = req.headers.host || "localhost";
      const proto = (req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https"));
      const baseUrl = `${proto}://${host}`;
      try {
        const { link } = await createPayrexxGateway({
          amountRappen: amount, currency: "CHF",
          purpose: `Schacht Consulting · Zielkunden-Cockpit · 150 Kontakte/Monat (${plan.label})`,
          referenceId: `schacht-${plan.id}-${Date.now()}`,
          successUrl: `${baseUrl}/?bezahlt=1`, cancelUrl: `${baseUrl}/?abbruch=1`,
          subscription: plan.recurring ? { interval: "P1M", period: "P3M", cancel: "P1M" } : null,
        });
        return send(res, 200, JSON.stringify({ ok: true, link, amountRappen: amount, currency: "CHF", reverseCharge: !zoneCh, recurring: !!plan.recurring }));
      } catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: String(e.message || e) })); }
    }

    // Static — Standardroute = Bestellseite
    let file = (p === "/" || p === "/bestellen" || p === "/bestellen/") ? "/bestellen.html" : decodeURIComponent(p);
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !existsSync(full)) return send(res, 404, "Nicht gefunden", "text/plain");
    const buf = await readFile(full);
    return send(res, 200, buf, MIME[path.extname(full)] || "application/octet-stream");
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    return send(res, 500, JSON.stringify({ error: String(e) }));
  }
}).listen(PORT, () => console.log(`Schacht-Bestellseite → :${PORT}`));
