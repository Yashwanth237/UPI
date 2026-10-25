/**
 * Root ("/") landing page for backend services that have no UI of their own (payment API,
 * checkout portal, SMS/Gmail observers). Without it, opening the port in a browser shows a bare
 * "Route Not Found", which reads like a crash. The page is self-contained (inline CSS, system
 * fonts) because these services do not serve /ui/* assets.
 */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[ch]);

const LANDING_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
});

/** Links to the places a person actually wants to land, honouring the configured base URLs. */
export function defaultLandingLinks() {
  return [
    { label: 'Merchant Admin', href: process.env.BASE_ADMIN_URL || 'http://localhost:6001' },
    { label: 'Demo Store', href: process.env.BASE_DEMO_STORE_URL || 'http://localhost:5000' },
    { label: 'Control Center', href: `http://localhost:${process.env.CONTROL_CENTER_PORT || 8090}` }
  ];
}

/**
 * @param {{ name: string, description: string, healthPath?: string, links?: Array<{label: string, href: string}> }} opts
 */
export function renderServiceLanding({ name, description, healthPath = '/health', links = defaultLandingLinks() }) {
  const linkItems = links
    .map((l) => `<a class="btn" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} · YOUPI PG</title>
<style>
  :root { color-scheme: light; --bg: #f6f8fb; --card: #fff; --ink: #0b1220; --muted: #526077; --line: #e2e8f0; --blue: #2563eb; --green: #15803d; }
  @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg: #0b1220; --card: #111a2e; --ink: #e6ebf3; --muted: #93a1b8; --line: #23304a; --blue: #60a5fa; --green: #4ade80; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { width: 100%; max-width: 520px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px; }
  .status { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--green); }
  .status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  h1 { margin: 10px 0 6px; font-size: 22px; line-height: 1.2; }
  p { margin: 0 0 20px; color: var(--muted); }
  .links { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--blue); text-decoration: none; font-weight: 600; font-size: 14px; }
  .btn:hover { border-color: var(--blue); }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  footer { margin-top: 20px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <span class="status">Running</span>
  <h1>${escapeHtml(name)}</h1>
  <p>${escapeHtml(description)}</p>
  <div class="links">${linkItems}</div>
  <footer>Machine-readable status: <a href="${escapeHtml(healthPath)}"><code>${escapeHtml(healthPath)}</code></a></footer>
</main>
</body>
</html>`;
}

/**
 * Serves the landing page for GET/HEAD "/". Returns true when the request was handled.
 * @param {string} pathname
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Parameters<typeof renderServiceLanding>[0]} opts
 */
export function serveServiceLanding(pathname, req, res, opts) {
  if (pathname !== '/' || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  res.writeHead(200, LANDING_HEADERS);
  res.end(req.method === 'HEAD' ? undefined : renderServiceLanding(opts));
  return true;
}
