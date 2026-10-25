import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { renderServiceLanding, serveServiceLanding, defaultLandingLinks } from './service-landing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Design-system assets served at /ui/<name>. A fixed allow-list (no path joining from user
 * input), so a crafted URL can never read other files.
 */
export const UI_ASSETS = Object.freeze({
  'tokens.css': { file: 'tokens.css', type: 'text/css; charset=utf-8' },
  'components.css': { file: 'components.css', type: 'text/css; charset=utf-8' },
  'fonts/dm-sans.woff2': { file: 'fonts/dm-sans.woff2', type: 'font/woff2', immutable: true },
  'fonts/sora.woff2': { file: 'fonts/sora.woff2', type: 'font/woff2', immutable: true }
});

/** Absolute path of a design-system file (for apps that inline or bundle it). */
export function uiAssetPath(name) {
  const asset = UI_ASSETS[name];
  return asset ? path.join(__dirname, asset.file) : null;
}

/**
 * Serves `/ui/*` requests. Returns true when the request was handled.
 * @param {string} pathname
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function serveUiAsset(pathname, req, res) {
  if (!pathname.startsWith('/ui/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const asset = UI_ASSETS[pathname.slice(4)];
  if (!asset) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not found');
    return true;
  }
  const filePath = path.join(__dirname, asset.file);
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*'
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}
