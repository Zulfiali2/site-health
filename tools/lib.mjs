// Shared helpers for the site-health robot.
import tls from "node:tls";

export const UA = "Mozilla/5.0 (compatible; SiteHealthBot/1.0; +https://github.com/Zulfiali2)";

export const host = (u) => new URL(u).hostname.replace(/^www\./, "");
export const slug = (u) => host(u).replace(/[^a-z0-9]+/gi, "-").toLowerCase();

// "biters.aqftrading.co.uk" -> "aqftrading.co.uk"
const SECOND_LEVEL = ["co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk", "com.au", "co.ae", "com.pk"];
export function registrable(hostname) {
  const h = hostname.replace(/^www\./, "").toLowerCase();
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  return SECOND_LEVEL.includes(last2) ? parts.slice(-3).join(".") : last2;
}

export async function timed(promise) {
  const t = performance.now();
  const v = await promise;
  return [v, Math.round(performance.now() - t)];
}

// fetch with timeout; never throws, returns {ok:false,error} instead
export async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      redirect: opts.redirect || "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: opts.accept || "text/html,application/xhtml+xml,*/*" },
    });
    const ms = Math.round(performance.now() - t0);
    const text = opts.body === false ? "" : await res.text().catch(() => "");
    return { ok: true, status: res.status, url: res.url, headers: res.headers, text, ms, redirected: res.redirected };
  } catch (e) {
    return { ok: false, error: (e.cause && (e.cause.code || e.cause.message)) || e.name || String(e), ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

// SSL certificate details for a hostname
export function sslInfo(hostname, timeout = 15000) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: false, timeout }, () => {
      const c = sock.getPeerCertificate();
      const valid = sock.authorized;
      const err = sock.authorizationError ? String(sock.authorizationError) : null;
      sock.end();
      if (!c || !c.valid_to) return resolve({ ok: false, error: "no certificate" });
      const expires = new Date(c.valid_to);
      resolve({
        ok: true, valid, error: err,
        issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null,
        expires: expires.toISOString().slice(0, 10),
        daysLeft: Math.floor((expires - Date.now()) / 86400000),
      });
    });
    sock.on("error", (e) => resolve({ ok: false, error: e.code || e.message }));
    sock.on("timeout", () => { sock.destroy(); resolve({ ok: false, error: "timeout" }); });
  });
}

// Domain expiry via RDAP (works for .com, .uk, .ae and most others)
export async function domainInfo(domain) {
  const r = await get("https://rdap.org/domain/" + domain, { accept: "application/rdap+json, application/json", timeout: 20000 });
  if (!r.ok || r.status !== 200) return { ok: false, error: r.error || "HTTP " + r.status };
  try {
    const j = JSON.parse(r.text);
    const exp = (j.events || []).find((e) => /expir/i.test(e.eventAction));
    const registrar = ((j.entities || []).find((e) => (e.roles || []).includes("registrar")) || {}).vcardArray;
    const regName = registrar && registrar[1] ? (registrar[1].find((v) => v[0] === "fn") || [])[3] : null;
    if (!exp) return { ok: true, expires: null, registrar: regName || null };
    const d = new Date(exp.eventDate);
    return { ok: true, expires: d.toISOString().slice(0, 10), daysLeft: Math.floor((d - Date.now()) / 86400000), registrar: regName || null };
  } catch (e) {
    return { ok: false, error: "bad RDAP response" };
  }
}

// --- tiny HTML helpers (regex based: good enough for a homepage audit) ---
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8211;|&ndash;/g, "–").replace(/&#8217;/g, "’").replace(/&nbsp;/g, " ").trim();
export function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = (html.match(re) || [])[0];
  if (!tag) return null;
  const c = tag.match(/content=["']([^"']*)["']/i);
  return c ? decode(c[1]) : "";
}
export function parseHome(html, pageUrl) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const gens = [...html.matchAll(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/gi)].map((m) => m[1]);
  const wpGen = gens.find((g) => /^WordPress/i.test(g));
  const elGen = gens.find((g) => /^Elementor/i.test(g));
  const wcGen = gens.find((g) => /^WooCommerce/i.test(g));
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\balt=["'][^"']+["']/i.test(t)).length;
  const isHttps = pageUrl.startsWith("https:");
  const mixed = isHttps ? [...html.matchAll(/<(?:img|script|iframe|source|link)\b[^>]+(?:src|href)=["']http:\/\/[^"']+["']/gi)].filter((m) => !/rel=["'](?:canonical|alternate|profile|dns-prefetch|preconnect)/i.test(m[0])).length : 0;
  const base = new URL(pageUrl);
  const links = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    if (m[1].startsWith("#")) continue;
    try {
      const u = new URL(decode(m[1]), base);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
      if (/\.(jpg|jpeg|png|webp|gif|svg|pdf|zip)$/i.test(u.pathname)) continue;
      if (/wp-login|wp-admin|add-to-cart|\?s=|\/feed\/?$|logout|cart\/?\?|my-account/i.test(u.href)) continue;
      u.hash = "";
      links.add(u.href);
    } catch {}
  }
  return {
    title: title ? decode(title.replace(/\s+/g, " ")) : null,
    description: meta(html, "description"),
    robots: meta(html, "robots"),
    ogImage: !!meta(html, "og:image"),
    canonical: /<link[^>]+rel=["']canonical["']/i.test(html),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    lang: (html.match(/<html[^>]+lang=["']([^"']+)["']/i) || [])[1] || null,
    h1: (html.match(/<h1\b/gi) || []).length,
    wordpress: wpGen ? (wpGen.match(/[\d.]+/) || [])[0] || "hidden" : /wp-content|wp-includes/i.test(html) ? "hidden" : null,
    elementor: elGen ? (elGen.match(/[\d.]+/) || [])[0] || "yes" : /elementor/i.test(html) ? "yes" : null,
    woocommerce: wcGen ? (wcGen.match(/[\d.]+/) || [])[0] || "yes" : /woocommerce/i.test(html) ? "yes" : null,
    images: imgs.length,
    imagesNoAlt: noAlt,
    mixedContent: mixed,
    links: [...links],
    bytes: Buffer.byteLength(html),
  };
}

export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// compare dotted versions: -1 a<b, 0 equal, 1 a>b
export function cmpVer(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
