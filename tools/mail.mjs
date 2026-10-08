// Sends email through Gmail using GitHub secrets. If the secrets aren't set yet, it explains and skips.
//   MAIL_USER          your Gmail address
//   MAIL_APP_PASSWORD  a Gmail "app password" (16 letters), NOT your normal password
//   MAIL_TO            who receives it, comma separated (e.g. "you@gmail.com, manager@company.com")
import nodemailer from "nodemailer";

export async function sendMail({ subject, html, attachments = [] }) {
  const { MAIL_USER, MAIL_APP_PASSWORD, MAIL_TO } = process.env;
  if (!MAIL_USER || !MAIL_APP_PASSWORD || !MAIL_TO) {
    console.log("Email skipped: add MAIL_USER, MAIL_APP_PASSWORD and MAIL_TO in GitHub → Settings → Secrets and variables → Actions.");
    return false;
  }
  const t = nodemailer.createTransport({ service: "gmail", auth: { user: MAIL_USER, pass: MAIL_APP_PASSWORD.replace(/\s+/g, "") } });
  await t.sendMail({ from: `Site Health Robot <${MAIL_USER}>`, to: MAIL_TO, subject, html, attachments });
  console.log("Email sent to", MAIL_TO);
  return true;
}
