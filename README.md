# Client Site Health

**Private.** A robot that checks every client website and reports problems before clients notice them.

## What it checks (every Monday)
| Area | Checks |
|---|---|
| Uptime | Site online, server response time, HTTP → HTTPS redirect |
| SSL & domain | Certificate valid, days until SSL expires, days until the domain expires (RDAP) |
| WordPress | Core version vs latest release, PHP version (if exposed), Elementor / WooCommerce detected |
| Security | Admin usernames exposed via REST API, XML-RPC enabled, readme.html, HSTS header |
| SEO | Hidden from Google (noindex), title, meta description, H1, XML sitemap, mixed content, image alt text |
| Links | Up to 40 internal links from the homepage, checked for 404s |
| Speed | Google Lighthouse **mobile**: performance, accessibility, best practices, SEO, and the biggest fixes |

Each problem becomes an issue (**critical / serious / warning / info**) with a suggested fix. Each site gets a health score out of 100.

## What you get
- **Monday email**: summary plus "Fix this week", with the interactive dashboard attached.
- **Downtime alert**: every 3 hours the robot checks that live sites are up. It emails once when a site goes down and once when it's back.
- **dashboard.html**: open it in any browser. It has week-by-week history, trends, a sortable and searchable table, site details and CSV export.

## Setup
1. **Email**: create a Gmail app password (Google Account → Security → 2-Step Verification → App passwords), then add three secrets in **Settings → Secrets and variables → Actions**:
   - `MAIL_USER`: your Gmail address
   - `MAIL_APP_PASSWORD`: the 16-letter app password
   - `MAIL_TO`: who receives it, comma separated
2. **First run**: Actions → *Weekly health report* → **Run workflow**.

## Add or remove sites
Edit `sites.json`. `env: "staging"` relaxes checks that don't apply to test sites (noindex, sitemap, domain expiry).

## Files
| File | Purpose |
|---|---|
| `sites.json` | The sites to monitor |
| `tools/check.mjs` | Runs every check and writes `reports/YYYY-MM-DD.json` |
| `tools/build-dashboard.mjs` | Builds `dashboard.html` and the email from all reports |
| `tools/uptime.mjs` | Downtime alerts |
| `tools/lib.mjs`, `tools/mail.mjs` | Helpers (HTTP, SSL, RDAP, HTML parsing, Gmail) |
