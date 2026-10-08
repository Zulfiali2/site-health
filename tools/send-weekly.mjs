// Emails the weekly summary (email.html) with the interactive dashboard attached.
import fs from "node:fs";
import path from "node:path";
import { sendMail } from "./mail.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const subject = fs.readFileSync(path.join(root, "email-subject.txt"), "utf8").trim();
const html = fs.readFileSync(path.join(root, "email.html"), "utf8");
const date = (subject.match(/\d{4}-\d{2}-\d{2}/) || [new Date().toISOString().slice(0, 10)])[0];
await sendMail({ subject, html, attachments: [{ filename: `site-health-${date}.html`, path: path.join(root, "dashboard.html") }] });
