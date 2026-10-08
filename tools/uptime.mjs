// Quick "is anything down?" check, run every 3 hours by GitHub Actions.
// Emails once when a live site goes down, and once when it comes back. State is kept in uptime-state.json.
import fs from "node:fs";
import path from "node:path";
import { get, pool, slug } from "./lib.mjs";
import { sendMail } from "./mail.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "sites.json"), "utf8"));
const stateFile = path.join(root, "uptime-state.json");
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}

const sites = cfg.sites.filter((s) => s.env === "live");
const isDown = (r) => !r.ok || r.status >= 500;
const results = await pool(sites, 6, async (s) => {
  let r = await get(s.url, { body: false, timeout: 25000 });
  if (isDown(r)) { await new Promise((ok) => setTimeout(ok, 30000)); r = await get(s.url, { body: false, timeout: 25000 }); } // confirm before alerting
  return { s, down: isDown(r), why: r.ok ? "HTTP " + r.status : r.error, ms: r.ms };
});

const now = new Date().toISOString();
const wentDown = [], cameBack = [];
for (const { s, down, why } of results) {
  const id = slug(s.url), was = state[id];
  if (down && !was) { state[id] = { since: now, why }; wentDown.push({ s, why }); }
  if (!down && was) { cameBack.push({ s, since: was.since }); delete state[id]; }
  console.log(down ? "✗" : "✓", s.name, why);
}
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const mins = (iso) => Math.round((Date.now() - new Date(iso)) / 60000);
const row = (color, title, s, note) => `<div style="padding:12px 14px;border-bottom:1px solid #EDEFEA"><b style="color:${color}">${title}</b> <b>${esc(s.name)}</b><div style="font-size:13px;color:#5E655C"><a href="${esc(s.url)}" style="color:#1F5FBF">${esc(s.url)}</a> · ${esc(note)}</div></div>`;
if (wentDown.length || cameBack.length) {
  const subject = wentDown.length ? `🔴 DOWN: ${wentDown.map((x) => x.s.name).join(", ")}` : `🟢 Back online: ${cameBack.map((x) => x.s.name).join(", ")}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1B1F1A"><h2 style="font-size:18px">${wentDown.length ? "Client site down" : "Site recovered"}</h2>
<div style="border:1px solid #DDE0D9;background:#fff">${wentDown.map((x) => row("#A62626", "✕ Down:", x.s, x.why + " (checked twice, 30 s apart)")).join("")}${cameBack.map((x) => row("#0B6B0B", "✓ Back:", x.s, "was down about " + mins(x.since) + " minutes")).join("")}</div>
${wentDown.length ? `<p style="font-size:13px;color:#3B4139">First steps: open the site yourself, check the hosting status page and error logs, and check the domain hasn't expired.</p>` : ""}
<p style="font-size:12px;color:#8C9389">Site Health Robot · checks every 3 hours · one email per incident</p></div>`;
  await sendMail({ subject, html });
} else console.log("No change. No email sent.");
