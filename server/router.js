// Tiny JSON API router
import { userFromToken, HttpError, E } from './core.js';

const routes = [];
export const RAW = Symbol('raw'); // handler wrote the response itself

export function route(method, pattern, fn, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, fn, pub: !!opts.public, raw: !!opts.raw });
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(E(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(E(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export async function dispatch(req, res, url) {
  try {
    const method = req.method;
    let matched = null, params = {}, pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      matched = r;
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      break;
    }
    if (!matched) throw E(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');

    // basic CSRF defence: browsers always send Origin on cross-site writes
    if (method !== 'GET' && req.headers.origin) {
      let ok = false;
      try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
      if (!ok) throw E(403, 'Cross-origin request blocked');
    }

    const token = parseCookies(req).sid;
    const user = userFromToken(token);
    if (!matched.pub && !user) throw E(401, 'Please sign in');

    let body = {};
    if (method !== 'GET' && method !== 'DELETE' && !matched.raw) body = await readBody(req);
    const query = Object.fromEntries(url.searchParams);
    const out = await matched.fn({ req, res, user, params, query, body, token });
    if (out === RAW) return;
    sendJson(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    if (e && /UNIQUE constraint/.test(e.message || '')) return sendJson(res, 409, { error: 'That value already exists' });
    console.error('API error:', e);
    sendJson(res, 500, { error: 'Something went wrong on the server' });
  }
}
