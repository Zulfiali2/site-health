// Weekly health check of every site in sites.json → reports/YYYY-MM-DD.json
//   node tools/check.mjs                 (all checks, no Lighthouse)
//   LIGHTHOUSE=1 node tools/check.mjs    (adds Google Lighthouse mobile scores; used by the GitHub Action)
import fs from "node:fs";
import path from "node:path";
import { get, sslInfo, domainInfo, parseHome, pool, cmpVer, registrable, host, slug } from "./lib.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "sites.json"), "utf8"));
const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);

/* ---------- latest WordPress version ---------- */
async function latestWordPress() {
  const r = await get("https://api.wordpress.org/core/version-check/1.7/", { accept: "application/json" });
  try { return JSON.parse(r.text).offers[0].current; } catch { return null; }
}

/* ---------- one site ---------- */
export async function audit(site, wpLatest, domains) {
  const c = { checked: new Date().toISOString() };
  const h = host(site.url);

  // 1. Homepage (HTTPS first, then HTTP)
  let home = await get(site.url);
  c.https = home.ok;
  if (!home.ok) {
    const plain = await get(site.url.replace(/^https:/, "http:"));
    if (plain.ok) home = plain;
  }
  c.up = home.ok && home.status < 500;
  c.status = home.ok ? home.status : null;
  c.error = home.ok ? null : home.error;
  c.responseMs = home.ms;
  c.finalUrl = home.ok ? home.url : null;

  // 2. HTTP → HTTPS redirect
  const hu = new URL(site.url); hu.protocol = "http:"; hu.pathname = "/";
  const http = await get(hu.href, { redirect: "manual", body: false, timeout: 15000 });
  const loc = http.ok ? http.headers.get("location") || "" : "";
  c.httpsRedirect = http.ok ? ([301, 302, 307, 308].includes(http.status) && loc.startsWith("https://")) : null;

  // 3. SSL + domain
  c.ssl = await sslInfo(h);
  c.domain = domains.get(registrable(h)) || null;

  if (home.ok && home.status < 400) {
    const H = home.headers;
    c.headers = {
      hsts: !!H.get("strict-transport-security"),
      nosniff: /nosniff/i.test(H.get("x-content-type-options") || ""),
      frame: !!H.get("x-frame-options") || /frame-ancestors/i.test(H.get("content-security-policy") || ""),
      server: H.get("server") || null,
      poweredBy: H.get("x-powered-by") || null,
      cache: H.get("cf-cache-status") || H.get("x-cache") || H.get("x-litespeed-cache") || null,
    };
    const php = (c.headers.poweredBy || "").match(/PHP\/([\d.]+)/i);
    c.php = php ? php[1] : null;

    const p = parseHome(home.text, home.url);
    c.page = { ...p, links: undefined, linkCount: p.links.length };

    // WordPress version: generator tag, else RSS feed
    c.wordpress = p.wordpress;
    if (c.wordpress === "hidden" || c.wordpress === null) {
      const feed = await get(new URL("/feed/", home.url).href, { timeout: 15000 });
      const v = feed.ok && (feed.text.match(/wordpress\.org\/\?v=([\d.]+)/) || [])[1];
      if (v) c.wordpress = v;
    }
    c.wordpressLatest = wpLatest;

    // 4. WordPress exposure checks
    const base = new URL("/", home.url).href;
    const [users, xmlrpc, readme, robots, sitemap] = await Promise.all([
      get(base + "wp-json/wp/v2/users", { accept: "application/json", timeout: 15000 }),
      get(base + "xmlrpc.php", { timeout: 15000 }),
      get(base + "readme.html", { timeout: 15000 }),
      get(base + "robots.txt", { timeout: 15000 }),
      (async () => {
        for (const s of ["sitemap_index.xml", "wp-sitemap.xml", "sitemap.xml"]) {
          const r = await get(base + s, { timeout: 15000 });
          if (r.ok && r.status === 200 && /<(sitemapindex|urlset)/i.test(r.text)) return s;
        }
        return null;
      })(),
    ]);
    let userList = [];
    try { if (users.ok && users.status === 200) userList = JSON.parse(users.text); } catch {}
    c.security = {
      usersExposed: Array.isArray(userList) && userList.length ? userList.length : 0,
      xmlrpc: xmlrpc.ok && xmlrpc.status === 405 && /XML-RPC/i.test(xmlrpc.text),
      readme: readme.ok && readme.status === 200 && /wordpress/i.test(readme.text),
    };
    c.seo = {
      robotsTxt: robots.ok && robots.status === 200,
      sitemap,
      blockedByRobots: robots.ok && robots.status === 200 && /^\s*Disallow:\s*\/\s*$/im.test(robots.text.split(/User-agent:\s*\*/i)[1] || ""),
    };

    // 5. Broken internal links from the homepage (max 40)
    const links = p.links.slice(0, 40);
    const results = await pool(links, 6, async (u) => {
      let r = await get(u, { method: "HEAD", body: false, timeout: 15000 });
      if (!r.ok || r.status === 405 || r.status === 403) r = await get(u, { body: false, timeout: 15000 });
      return { url: u, status: r.ok ? r.status : null, error: r.ok ? null : r.error };
    });
    c.links = { checked: links.length, broken: results.filter((r) => r.status === null || r.status >= 400) };
  }
  return c;
}

/* ---------- Lighthouse (mobile) ---------- */
async function lighthouseAll(sites) {
  const { chromium } = await import("playwright");
  const { default: lighthouse } = await import("lighthouse");
  const chromeLauncher = await import("chrome-launcher");
  const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"] });
  const out = {};
  for (const s of sites) {
    try {
      const run = await lighthouse(s.url, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance", "accessibility", "best-practices", "seo"] });
      const l = run.lhr; if (l.runtimeError) throw new Error(l.runtimeError.message);
      const pct = (k) => (l.categories[k] && l.categories[k].score != null ? Math.round(l.categories[k].score * 100) : null);
      const a = (k) => l.audits[k] || {};
      out[s.url] = {
        performance: pct("performance"), accessibility: pct("accessibility"), bestPractices: pct("best-practices"), seo: pct("seo"),
        lcp: a("largest-contentful-paint").displayValue || null, cls: a("cumulative-layout-shift").displayValue || null,
        tbt: a("total-blocking-time").displayValue || null,
        weightKB: a("total-byte-weight").numericValue ? Math.round(a("total-byte-weight").numericValue / 1024) : null,
        topFix: (Object.values(l.audits).filter((x) => x.details && x.details.type === "opportunity" && x.numericValue > 300)
          .sort((p, q) => q.numericValue - p.numericValue).slice(0, 3).map((x) => x.title)),
      };
      console.log("  lighthouse ✓", s.name, out[s.url].performance);
    } catch (e) { console.log("  lighthouse ✗", s.name, String(e.message).split("\n")[0]); }
  }
  await chrome.kill();
  return out;
}

/* ---------- turn checks into issues ---------- */
const W = { critical: 40, serious: 15, warning: 5, info: 1 };
export function issuesFor(site, c, lh) {
  const I = [], add = (sev, key, title, fix) => I.push({ sev, key, title, fix });
  const staging = site.env === "staging";

  if (!c.up) { add("critical", "down", c.status ? `Site returns an error (HTTP ${c.status})` : `Site is not reachable (${c.error || "no response"})`, "Check the hosting account, DNS and server error logs."); return I; }
  if (c.status >= 400) add("critical", "http-error", `Homepage returns HTTP ${c.status}`, "Check the homepage setting and permalinks in WordPress.");
  if (c.ssl && !c.ssl.ok) add(staging ? "serious" : "critical", "ssl-missing", "No working SSL certificate (HTTPS)", "Issue a free Let's Encrypt certificate in the hosting panel.");
  else if (c.ssl && !c.ssl.valid) add("critical", "ssl-invalid", `SSL certificate problem: ${c.ssl.error || "not trusted"}`, "Reissue the certificate for the correct domain(s).");
  else if (c.ssl && c.ssl.daysLeft < 0) add("critical", "ssl-expired", `SSL certificate expired ${-c.ssl.daysLeft} day${c.ssl.daysLeft === -1 ? "" : "s"} ago`, "Visitors see a security warning. Renew the certificate in the hosting panel now.");
  else if (c.ssl && c.ssl.daysLeft < 7) add("critical", "ssl-expiring", `SSL certificate expires in ${c.ssl.daysLeft} days`, "Renew now or check that auto-renewal is working.");
  else if (c.ssl && c.ssl.daysLeft < 21) add("warning", "ssl-expiring", `SSL certificate expires in ${c.ssl.daysLeft} days`, "Usually renews automatically. Confirm auto-renewal is on.");
  if (c.domain && c.domain.daysLeft != null && !staging) {
    if (c.domain.daysLeft < 0) add("critical", "domain-expired", `Domain expired ${-c.domain.daysLeft} days ago (${c.domain.expires})`, "Renew immediately with the registrar before it is lost.");
    else if (c.domain.daysLeft < 14) add("critical", "domain-expiring", `Domain expires in ${c.domain.daysLeft} days (${c.domain.expires})`, "Renew the domain with the registrar today.");
    else if (c.domain.daysLeft < 45) add("serious", "domain-expiring", `Domain expires in ${c.domain.daysLeft} days (${c.domain.expires})`, "Remind the client or renew; check auto-renew.");
  }
  if (c.httpsRedirect === false && c.https) add("serious", "no-https-redirect", "http:// does not redirect to https://", "Force HTTPS in the hosting panel or Really Simple SSL.");
  if (c.page) {
    const noindex = /noindex/i.test(c.page.robots || "") || (c.seo && c.seo.blockedByRobots);
    if (noindex) staging ? add("info", "noindex", "Hidden from Google (expected on staging)", "Remove before launch: Settings → Reading → Search engine visibility.")
      : add("critical", "noindex", "Live site is hidden from Google (noindex)", "Settings → Reading → untick 'Discourage search engines'.");
    if (!c.page.title) add("warning", "no-title", "Homepage has no title tag", "Set an SEO title in Yoast / Rank Math.");
    if (!c.page.description) add("warning", "no-description", "Homepage has no meta description", "Write a 150–160 character description in the SEO plugin.");
    if (c.page.h1 === 0) add("warning", "no-h1", "Homepage has no H1 heading", "Make the main hero heading an H1 in Elementor.");
    else if (c.page.h1 > 1) add("info", "many-h1", `Homepage has ${c.page.h1} H1 headings`, "Keep one H1; change the others to H2.");
    if (c.page.mixedContent) add("warning", "mixed-content", `${c.page.mixedContent} item(s) load over insecure http://`, "Update the URLs to https:// (Better Search Replace).");
    if (c.page.imagesNoAlt > 5) add("info", "alt-text", `${c.page.imagesNoAlt} images have no alt text`, "Add alt text in the Media Library (helps SEO and accessibility).");
    if (!c.page.viewport) add("serious", "no-viewport", "No mobile viewport tag", "Check the theme header: the page may not scale on phones.");
  }
  if (c.seo && !c.seo.sitemap && !staging) add("warning", "no-sitemap", "No XML sitemap found", "Enable the sitemap in Yoast / Rank Math and submit it to Search Console.");
  if (c.links && c.links.broken.length) add(c.links.broken.length > 3 ? "serious" : "warning", "broken-links", `${c.links.broken.length} broken link(s) on the homepage`, "Fix or remove: " + c.links.broken.slice(0, 3).map((b) => new URL(b.url).pathname).join(", "));
  if (c.wordpress && c.wordpress !== "hidden" && c.wordpressLatest) {
    const [a, b] = [c.wordpress.split(".").slice(0, 2).join("."), c.wordpressLatest.split(".").slice(0, 2).join(".")];
    if (cmpVer(a, b) < 0) add("serious", "wp-outdated", `WordPress ${c.wordpress} is out of date (latest ${c.wordpressLatest})`, "Back up, then update WordPress core, theme and plugins.");
    else if (cmpVer(c.wordpress, c.wordpressLatest) < 0) add("warning", "wp-patch", `WordPress ${c.wordpress} is missing a security patch (${c.wordpressLatest})`, "Apply the minor update; these are usually safe and automatic.");
  }
  if (c.php && cmpVer(c.php, "8.1") < 0) add("serious", "php-old", `Server runs old PHP ${c.php}`, "Switch to PHP 8.2+ in the hosting panel (test on staging first).");
  if (c.php) add("info", "php-exposed", "Server reveals its PHP version", "Hide the X-Powered-By header (expose_php = Off).");
  if (c.security) {
    if (c.security.usersExposed) add("warning", "users-exposed", "Admin usernames are publicly listed (/wp-json/wp/v2/users)", "Block user enumeration with a security plugin (Wordfence, Solid Security).");
    if (c.security.xmlrpc) add("info", "xmlrpc", "XML-RPC is enabled (common attack target)", "Disable XML-RPC if Jetpack/apps don't need it.");
    if (c.security.readme) add("info", "readme", "readme.html reveals WordPress details", "Delete /readme.html from the server.");
  }
  if (c.headers && !c.headers.hsts && c.https) add("info", "no-hsts", "No HSTS security header", "Add Strict-Transport-Security via the host or a headers plugin.");
  if (c.responseMs > 2500) add("warning", "slow-server", `Server is slow to respond (${(c.responseMs / 1000).toFixed(1)} s)`, "Enable page caching (LiteSpeed Cache / WP Rocket) or upgrade hosting.");
  if (lh) {
    if (lh.performance != null && lh.performance < 50) add("serious", "slow-mobile", `Very slow on mobile (speed ${lh.performance}/100)`, lh.topFix && lh.topFix.length ? "Biggest wins: " + lh.topFix.join("; ") : "Compress images, cache pages, reduce plugins.");
    else if (lh.performance != null && lh.performance < 70) add("warning", "slow-mobile", `Slow on mobile (speed ${lh.performance}/100)`, lh.topFix && lh.topFix.length ? "Biggest wins: " + lh.topFix.join("; ") : "Compress images and enable caching.");
    if (lh.seo != null && lh.seo < 80 && !staging) add("warning", "seo-score", `Google SEO checks score ${lh.seo}/100`, "Run Lighthouse → SEO and fix the listed items.");
    if (lh.accessibility != null && lh.accessibility < 80) add("info", "a11y-score", `Accessibility score ${lh.accessibility}/100`, "Fix colour contrast, link names and alt text.");
  }
  const order = { critical: 0, serious: 1, warning: 2, info: 3 };
  return I.sort((a, b) => order[a.sev] - order[b.sev]);
}
export function scoreOf(issues) {
  const s = Math.max(0, 100 - issues.reduce((t, i) => t + W[i.sev], 0));
  const status = issues.some((i) => i.sev === "critical") ? "critical" : issues.some((i) => i.sev === "serious") || s < 80 ? "attention" : "healthy";
  return { score: s, status };
}

/* ---------- run ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const sites = cfg.sites;
  console.log(`Checking ${sites.length} sites…`);
  const wpLatest = await latestWordPress();
  console.log("Latest WordPress:", wpLatest);
  const domainNames = [...new Set(sites.map((s) => registrable(host(s.url))))];
  const domains = new Map();
  await pool(domainNames, 3, async (d) => { domains.set(d, await domainInfo(d)); });

  const checks = await pool(sites, 4, async (s) => {
    const c = await audit(s, wpLatest, domains);
    console.log(c.up ? "✓" : "✗", s.name, c.status || c.error, c.responseMs + "ms");
    return c;
  });
  const lh = process.env.LIGHTHOUSE ? await lighthouseAll(sites.filter((s, i) => checks[i].up)) : {};

  const report = {
    date: today, wpLatest,
    sites: sites.map((s, i) => {
      const issues = issuesFor(s, checks[i], lh[s.url]);
      return { ...s, id: slug(s.url), ...scoreOf(issues), checks: checks[i], lighthouse: lh[s.url] || null, issues };
    }),
  };
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", today + ".json"), JSON.stringify(report, null, 1));
  const n = (st) => report.sites.filter((x) => x.status === st).length;
  console.log(`\nSaved reports/${today}.json — healthy ${n("healthy")}, needs attention ${n("attention")}, critical ${n("critical")}`);
}
