const UPSTREAMS = {
  nyx: { rest: 'https://api.nymtech.net', rpc: 'https://rpc.nymtech.net' },
  gravity: { rest: 'https://gravitychain.io:1317', rpc: 'https://gravitychain.io:26657' },
};

const NYM = '0x525a8f6f3ba4752868cde25164382bfbae3990e1';
const DENOM = 'ibc/0C273962C274B2C05B22D9474BFE5B84D6A6FCAD198CB9B0ACD35EA521A36606';
const RPC_METHODS = new Set([
  'status', 'health', 'abci_query', 'abci_info', 'block', 'block_results',
  'validators', 'genesis', 'tx_search', 'tx', 'broadcast_tx_sync',
]);
const RPC_GET_METHODS = new Set([
  'status', 'health', 'abci_query', 'abci_info', 'block', 'block_results',
  'validators', 'genesis', 'tx_search', 'tx',
]);
const NYX_ADDRESS = /^n1[0-9a-z]{20,60}$/;
const GRAVITY_ADDRESS = /^gravity1[0-9a-z]{20,60}$/;
const INTEGER = /^\d{1,30}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function restAllowed(chain, url) {
  const p = url.pathname.replace(`/api/${chain}-rest`, '');
  if (p === '/cosmos/base/tendermint/v1beta1/blocks/latest') return true;
  if (chain === 'nyx') {
    if (p === '/ibc/core/channel/v1/channels/channel-0/ports/transfer') return true;
    if (p === '/ibc/core/client/v1/client_status/07-tendermint-1') return true;
    const balance = p.match(/^\/cosmos\/bank\/v1beta1\/balances\/([^/]+)\/by_denom$/);
    return Boolean(balance && NYX_ADDRESS.test(balance[1]) && url.searchParams.get('denom') === 'unym');
  }
  if (p === '/gravity/v1beta/params' || p === '/gravity/v1beta/query_last_observed_eth_block' ||
      p === '/gravity/v1beta/batch/outgoingtx' || p === '/gravity/v1beta/valset/requests' ||
      p === '/ibc/core/channel/v1/channels/channel-18/ports/transfer' ||
      p === '/ibc/core/client/v1/client_status/07-tendermint-33') return true;
  if (p === `/gravity/v1beta/cosmos_originated/erc20_to_denom`)
    return url.searchParams.get('erc20')?.toLowerCase() === NYM;
  if (p === `/ibc/apps/transfer/v1/denom_traces/${DENOM.slice(4)}`) return true;
  const balance = p.match(/^\/cosmos\/bank\/v1beta1\/balances\/([^/]+)\/by_denom$/);
  if (balance) return GRAVITY_ADDRESS.test(balance[1]) && url.searchParams.get('denom') === DENOM;
  const pending = p === '/gravity/v1beta/query_pending_send_to_eth';
  if (pending) return GRAVITY_ADDRESS.test(url.searchParams.get('sender_address') || '');
  if (p === '/gravity/v1beta/valset') return INTEGER.test(url.searchParams.get('nonce') || '');
  const confirms = p === '/gravity/v1beta/batch/confirms';
  if (confirms) return INTEGER.test(url.searchParams.get('nonce') || '') && url.searchParams.get('contract_address')?.toLowerCase() === NYM;
  return /^\/gravity\/v1beta\/confirms\/\d{1,30}$/.test(p);
}

async function readBounded(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new RangeError('Request body is too large.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new RangeError('Request body is too large.'); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function rpc(request, chain, url) {
  const basePath = `/api/${chain}-rpc`;
  if (request.method === 'POST' && url.pathname !== basePath) return json({ error: 'Unknown RPC path.' }, 404);
  if (request.method === 'GET' && !url.pathname.startsWith(`${basePath}/`)) return json({ error: 'Unknown RPC path.' }, 404);
  let body;
  if (request.method === 'POST') {
    if (request.headers.get('origin') !== url.origin) return json({ error: 'RPC requests must come from the bridge site.' }, 403);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'JSON required.' }, 415);
    try {
      body = await readBounded(request, 2_000_000);
      const call = JSON.parse(new TextDecoder().decode(body));
      if (!call || Array.isArray(call) || typeof call !== 'object' || !RPC_METHODS.has(call.method))
        return json({ error: 'Unsupported RPC method.' }, 403);
    } catch (error) {
      return json({ error: error instanceof RangeError ? error.message : 'Invalid JSON-RPC request.' }, error instanceof RangeError ? 413 : 400);
    }
  } else if (request.method === 'GET') {
    const method = url.pathname.slice(`/api/${chain}-rpc/`.length);
    if (!RPC_GET_METHODS.has(method)) return json({ error: 'Unsupported read-only RPC method.' }, 403);
  } else return json({ error: 'Method not allowed.' }, 405);

  const upstream = new URL(url.pathname.replace(`/api/${chain}-rpc`, '') || '/', UPSTREAMS[chain].rpc);
  upstream.search = url.search;
  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers: request.method === 'POST' ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: request.method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(25_000),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) return json({ error: `${chain} RPC returned an unexpected redirect.` }, 502);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch {
    return json({ error: `${chain} RPC is temporarily unavailable.` }, 502);
  }
}

async function handleApi(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST')
    return json({ error: 'Method not allowed.' }, 405);
  if (url.pathname === '/api/config' && request.method === 'GET') {
    const base = url.origin;
    return json({
      'nyx-rest': `${base}/api/nyx-rest`, 'nyx-rpc': `${base}/api/nyx-rpc`,
      'gravity-rest': `${base}/api/gravity-rest`, 'gravity-rpc': `${base}/api/gravity-rpc`,
    });
  }
  const rpcMatch = url.pathname.match(/^\/api\/(nyx|gravity)-rpc(?:\/.*)?$/);
  if (rpcMatch) return rpc(request, rpcMatch[1], url);
  const restMatch = url.pathname.match(/^\/api\/(nyx|gravity)-rest(\/.*)$/);
  if (restMatch) {
    if (request.method !== 'GET') return json({ error: 'REST endpoints are read-only.' }, 405);
    const chain = restMatch[1];
    if (!restAllowed(chain, url)) return json({ error: 'This chain endpoint is not enabled.' }, 404);
    const upstream = new URL(restMatch[2], UPSTREAMS[chain].rest);
    upstream.search = url.search;
    try {
      const response = await fetch(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25_000), redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) return json({ error: `${chain} REST API returned an unexpected redirect.` }, 502);
      return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch {
      return json({ error: `${chain} REST API is temporarily unavailable.` }, 502);
    }
  }
  if (url.pathname.startsWith('/api/')) return json({ error: 'Unknown API endpoint.' }, 404);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiResponse = await handleApi(request, env, url);
    if (apiResponse) return apiResponse;
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('x-frame-options', 'DENY');
    headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (url.pathname === '/' || url.pathname.endsWith('.html')) headers.set('cache-control', 'no-cache');
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
