// Builds dashboard.html (interactive, self-contained, works offline) and email.html (summary for the weekly email)
// from every report in reports/. Run: node tools/build-dashboard.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "sites.json"), "utf8"));
const dir = path.resolve(root, process.env.REPORTS_DIR || "reports");
const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-26); // last 6 months
if (!files.length) { console.error("No reports yet. Run tools/check.mjs first."); process.exit(1); }

// keep only what the dashboard shows (smaller file)
const slim = (r) => ({
  date: r.date, wpLatest: r.wpLatest,
  sites: r.sites.map((s) => ({
    id: s.id, name: s.name, url: s.url, group: s.group, env: s.env, status: s.status, score: s.score, issues: s.issues,
    lighthouse: s.lighthouse && { performance: s.lighthouse.performance, accessibility: s.lighthouse.accessibility, bestPractices: s.lighthouse.bestPractices, seo: s.lighthouse.seo, lcp: s.lighthouse.lcp, cls: s.lighthouse.cls, weightKB: s.lighthouse.weightKB },
    checks: {
      up: s.checks.up, status: s.checks.status, error: s.checks.error, responseMs: s.checks.responseMs, httpsRedirect: s.checks.httpsRedirect,
      ssl: s.checks.ssl, domain: s.checks.domain, wordpress: s.checks.wordpress, php: s.checks.php,
      headers: s.checks.headers && { hsts: s.checks.headers.hsts, server: s.checks.headers.server },
      page: s.checks.page && { title: s.checks.page.title, description: !!s.checks.page.description, h1: s.checks.page.h1, elementor: s.checks.page.elementor, woocommerce: s.checks.page.woocommerce, images: s.checks.page.images, imagesNoAlt: s.checks.page.imagesNoAlt },
      seo: s.checks.seo, security: s.checks.security, links: s.checks.links,
    },
  })),
});
const reports = files.map((f) => slim(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
const data = JSON.stringify({ owner: cfg.owner, title: cfg.title, reports }).replace(/</g, "\\u003c");
const tpl = fs.readFileSync(path.join(root, "tools", "dashboard.template.html"), "utf8");
fs.writeFileSync(path.join(root, "dashboard.html"), tpl.replace("/*DATA*/", () => data));

/* ---------- email summary (inline styles: email apps ignore <style>) ---------- */
const cur = reports[reports.length - 1], prev = reports[reports.length - 2];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (r, st) => r.sites.filter((s) => s.status === st).length;
const avg = (r) => { const v = r.sites.map((s) => s.lighthouse && s.lighthouse.performance).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
const d = (a, b, good) => (b == null || a == null || a === b ? "" : ` <span style="color:${(a > b) === good ? "#0B6B0B" : "#A62626"};font-size:12px">(${a > b ? "+" : ""}${a - b} vs last week)</span>`);
const COLORS = { critical: ["#F9E1E0", "#A62626", "✕ Critical"], attention: ["#FDF2D8", "#7A5200", "! Needs attention"], healthy: ["#E5F4E3", "#0B6B0B", "✓ Healthy"] };
const SEV = { critical: ["#F9E1E0", "#A62626"], serious: ["#FBE8DF", "#9A3F1A"] };
const down = cur.sites.filter((s) => !s.checks.up);
const issues = [];
cur.sites.forEach((s) => s.issues.forEach((x) => { if (x.sev === "critical" || x.sev === "serious") issues.push({ s, x }); }));
issues.sort((a, b) => (a.x.sev === b.x.sev ? (a.s.env === "staging") - (b.s.env === "staging") : a.x.sev === "critical" ? -1 : 1));
const dateStr = new Date(cur.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const tile = (label, value, extra) => `<td style="padding:12px 14px;border:1px solid #DDE0D9;background:#fff;vertical-align:top"><div style="font-size:12px;color:#5E655C">${label}</div><div style="font:600 24px 'Courier New',monospace;color:#1B1F1A">${value}</div>${extra || ""}</td>`;
const subject = down.length ? `⚠ ${down.length} site${down.length > 1 ? "s" : ""} down · Weekly site health ${cur.date}`
  : `Weekly site health ${cur.date}: ${n(cur, "critical")} critical, ${n(cur, "attention")} need attention`;
const email = `<!doctype html><html><body style="margin:0;background:#F4F5F2;font-family:Arial,Helvetica,sans-serif;color:#1B1F1A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
<tr><td style="padding:0 0 16px"><div style="font-size:13px;color:#5E655C">${esc(cfg.title)} · ${esc(dateStr)}</div>
<h1 style="font-size:22px;margin:6px 0 0">${down.length ? `${down.length} site${down.length > 1 ? "s are" : " is"} down` : n(cur, "critical") ? `${n(cur, "critical")} site${n(cur, "critical") > 1 ? "s need" : " needs"} urgent action` : "All client sites are online"}</h1>
<p style="margin:8px 0 0;font-size:15px;color:#3B4139">${cur.sites.length - n(cur, "critical") - n(cur, "attention")} of ${cur.sites.length} sites are healthy this week. Full details are in the attached dashboard (open <b>dashboard.html</b> in any browser).</p></td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
${tile("Sites online", `${cur.sites.filter((s) => s.checks.up).length}/${cur.sites.length}`)}
${tile(COLORS.critical[2], n(cur, "critical"), prev ? `<div>${d(n(cur, "critical"), n(prev, "critical"), false)}</div>` : "")}
${tile(COLORS.attention[2], n(cur, "attention"), prev ? `<div>${d(n(cur, "attention"), n(prev, "attention"), false)}</div>` : "")}
${tile("Avg mobile speed", avg(cur) ?? "–", prev ? `<div>${d(avg(cur), avg(prev), true)}</div>` : "")}
</tr></table></td></tr>
<tr><td style="padding:22px 0 8px"><h2 style="font-size:16px;margin:0">Fix this week</h2></td></tr>
<tr><td style="background:#fff;border:1px solid #DDE0D9">
${issues.length ? issues.slice(0, 12).map(({ s, x }) => `<div style="padding:12px 14px;border-bottom:1px solid #EDEFEA">
<span style="display:inline-block;font:bold 10px Arial;text-transform:uppercase;padding:2px 6px;border-radius:4px;background:${SEV[x.sev][0]};color:${SEV[x.sev][1]}">${x.sev}</span>
<b style="font-size:14px"> ${esc(x.title)}</b><div style="font-size:13px;color:#5E655C;margin-top:3px">${esc(s.name)}${s.env === "staging" && !/staging/i.test(s.name) ? " (staging)" : ""} · <a href="${esc(s.url)}" style="color:#1F5FBF">${esc(s.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a></div>
<div style="font-size:13px;color:#3B4139;margin-top:3px"><b>Fix:</b> ${esc(x.fix)}</div></div>`).join("") + (issues.length > 12 ? `<div style="padding:10px 14px;font-size:13px;color:#5E655C">+${issues.length - 12} more in the dashboard</div>` : "")
  : `<div style="padding:16px 14px;font-size:14px;color:#0B6B0B">✓ No critical or serious issues this week.</div>`}
</td></tr>
<tr><td style="padding:18px 0 0;font-size:12px;color:#8C9389">Sent automatically by the site-health robot (GitHub Actions) every Monday. Contains security findings: please don't forward outside the team.</td></tr>
</table></td></tr></table></body></html>`;
fs.writeFileSync(path.join(root, "email.html"), email);
fs.writeFileSync(path.join(root, "email-subject.txt"), subject);
console.log(`dashboard.html (${reports.length} reports, ${Math.round(fs.statSync(path.join(root, "dashboard.html")).size / 1024)} KB) and email.html built. Subject: ${subject}`);
