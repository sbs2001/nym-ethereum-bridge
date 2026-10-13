import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8787);
const origin = `http://127.0.0.1:${port}`;
const routes = {
  'nyx-rest': process.env.NYX_REST || 'https://api.nymtech.net',
  'nyx-rpc': process.env.NYX_RPC || 'https://rpc.nymtech.net',
  'gravity-rest': process.env.GRAVITY_REST || 'https://gravitychain.io:1317',
  'gravity-rpc': process.env.GRAVITY_RPC || 'https://gravitychain.io:26657',
};
for (const endpoint of Object.values(routes)) {
  if (new URL(endpoint).protocol !== 'https:') throw Error('Upstream endpoints must use HTTPS');
}
const rpcMethods = new Set(['status', 'health', 'abci_query', 'abci_info', 'block', 'block_results', 'tx', 'tx_search', 'validators', 'genesis', 'broadcast_tx_sync']);
const dev = process.argv.includes('--dev');
const vite = dev ? await (await import('vite')).createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' }) : null;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const fail = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
  if (req.headers.host !== `127.0.0.1:${port}`) return fail(403, `Open ${origin}`);
  if (req.headers.origin && req.headers.origin !== origin) return fail(403, 'Foreign origin rejected');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/config') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(routes)); }
    if (url.pathname.startsWith('/api/')) {
      const [, , key, ...parts] = url.pathname.split('/');
      if (!routes[key]) return fail(404, 'Unknown upstream');
      if (req.method !== 'GET' && req.method !== 'POST') return fail(405, 'Unsupported method');
      if (req.method === 'GET' && key.endsWith('-rpc') && (!rpcMethods.has(parts.join('/')) || parts.join('/').startsWith('broadcast'))) return fail(403, 'Only read-only RPC GET methods are allowed');
      let body;
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || !key.endsWith('-rpc')) return fail(403, 'RPC POST requires the local app origin');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) return fail(413, 'Request too large'); chunks.push(chunk); }
        body = Buffer.concat(chunks);
        const rpc = JSON.parse(body.toString());
        if (Array.isArray(rpc) || !rpcMethods.has(rpc.method)) return fail(403, 'Unsupported RPC method');
      }
      const upstream = new URL('/' + parts.join('/') + url.search, routes[key]);
      if (upstream.origin !== new URL(routes[key]).origin) return fail(403, 'Invalid upstream');
      const response = await fetch(upstream, { method: req.method, body, headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(25_000), redirect: 'error' });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text()); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Unsupported method');
    if (vite) return vite.middlewares(req, res, () => fail(404, 'Not found'));
    const target = path.resolve(root, 'dist', '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!target.startsWith(path.join(root, 'dist') + path.sep)) return fail(403, 'Invalid path');
    if (!(await stat(target)).isFile()) return fail(404, 'Not found');
    res.setHeader('content-type', mime[path.extname(target)] || 'application/octet-stream');
    res.end(await readFile(target));
  } catch (error) { fail(502, error.message + (dev ? '' : ' — build the app before starting, or use --dev.')); }
});
server.listen(port, '127.0.0.1', () => console.log(`NYM bridge: ${origin} (${dev ? 'development' : 'built files'})`));
