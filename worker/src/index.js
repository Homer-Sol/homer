// HOMER worker: serves the site, forwards a short list of RPC calls so the key stays here, and reads wills from chain.
//   POST /rpc            read and send calls for the page (allowlist)
//   GET  /v1/will/:owner seals this wallet made: what, to whom, when the dawn is
//   GET  /v1/heir/:addr  seals that name this wallet as heir
//   GET  /v1/stats       wills, seals, SOL under the wing, the next dawn
//   GET  /v1/config      fee and token settings for the page
//   GET  /v1/assets?ids= names, symbols and decimals of up to 100 mints
// A will is any Jupiter Lock escrow with a HOMER metadata account. Nothing is stored here: the chain is the record.

const LOCKER = 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn';
const WSOL = 'So11111111111111111111111111111111111111112';
const ALLOWED = new Set(['getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash', 'getTokenAccountsByOwner', 'sendTransaction', 'simulateTransaction', 'getSignatureStatuses']);
const INDEX_TTL = 60, MAX_BODY = 64 * 1024;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

// ---------- base58 ----------
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
export const isPubkey = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- chain ----------
async function call(env, method, params) {
  const r = await fetch(env.SOL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json().catch(() => null);
  if (!j || j.error) throw Object.assign(new Error(j?.error?.message || 'RPC is busy'), { status: 503 });
  return j.result;
}

// VestingEscrow after its 8-byte tag: recipient, mint, creator, base, then flags and u64s
export function readEscrow(address, b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const key = (o) => b58encode(b.subarray(o, o + 32));
  const u64 = (o) => v.getBigUint64(o, true);
  const total = u64(160) + u64(168) * u64(176);
  return {
    escrow: address, heir: key(8), mint: key(40), owner: key(72),
    can_change_heir: b[137] === 1 || b[137] === 3, owner_can_cancel: b[138] === 1 || b[138] === 3, token_2022: b[139] === 1,
    dawn: Number(u64(144)), amount: String(total - u64(184)), sealed: Number(u64(192)), cancelled: Number(u64(200)) > 0,
  };
}

// every escrow with a HOMER metadata account: the metadata names its escrow at byte 8 and starts its name at byte 40
async function index(env) {
  const cache = caches.default, key = new Request('https://homer.internal/index');
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const name = new TextEncoder().encode('HOMER');
  const tag = b58encode(Uint8Array.from([name.length, 0, 0, 0, ...name]));
  const metas = await call(env, 'getProgramAccounts', [LOCKER, { encoding: 'base64', dataSlice: { offset: 8, length: 32 }, filters: [{ memcmp: { offset: 40, bytes: tag } }] }]);
  const escrows = metas.map((m) => b58encode(fromB64(m.account.data[0])));
  const seals = [];
  for (let i = 0; i < escrows.length; i += 100) {
    const part = escrows.slice(i, i + 100);
    const got = await call(env, 'getMultipleAccounts', [part, { encoding: 'base64' }]);
    got.value.forEach((a, k) => {
      if (!a || a.owner !== LOCKER) return;
      const e = readEscrow(part[k], fromB64(a.data[0]));
      // a will must be one the owner can take back; anything else is not ours to show as a will
      if (!e.cancelled && e.owner_can_cancel && e.heir !== e.owner && e.amount !== '0') seals.push(e);
    });
  }
  await cache.put(key, new Response(JSON.stringify(seals), { headers: { 'cache-control': `max-age=${INDEX_TTL}` } }));
  return seals;
}

// names, symbols, decimals and images for the page, from the DAS API
async function assets(env, mints) {
  const ids = [...new Set(mints)].filter((m) => m !== WSOL);
  const out = { [WSOL]: { symbol: 'SOL', name: 'Solana', decimals: 9, image: null } };
  if (!ids.length) return out;
  try {
    const got = await call(env, 'getAssetBatch', { ids });
    for (const a of got || []) if (a) out[a.id] = { symbol: a.content?.metadata?.symbol || null, name: a.content?.metadata?.name || null, decimals: a.token_info?.decimals ?? null, image: a.content?.links?.image || null };
  } catch {}
  return out;
}

async function stats(env) {
  const seals = await index(env);
  const now = Math.floor(Date.now() / 1000);
  const ahead = seals.filter((s) => s.dawn > now).map((s) => s.dawn).sort((a, b) => a - b);
  return {
    wills: new Set(seals.map((s) => s.owner)).size, seals: seals.length, heirs: new Set(seals.map((s) => s.heir)).size,
    sol: seals.filter((s) => s.mint === WSOL).reduce((t, s) => t + Number(s.amount), 0) / 1e9,
    next_dawn: ahead[0] || null, opened: seals.filter((s) => s.dawn <= now).length,
  };
}

async function rpc(request, env) {
  if (!env.SOL_RPC_URL) return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'RPC is not set' } }, 503);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too large' } }, 413);
  let c; try { c = JSON.parse(text); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad JSON' } }, 400); }
  if (Array.isArray(c) || !ALLOWED.has(c?.method)) return json({ jsonrpc: '2.0', id: c?.id ?? null, error: { code: -32000, message: 'Method not allowed' } }, 403);
  const up = await fetch(env.SOL_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  return new Response(up.body, { status: up.status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url), p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/rpc' && request.method === 'POST') return rpc(request, env);
      if (p === '/v1/config') return json({ fee_lamports: env.FEE_WALLET ? Number(env.FEE_LAMPORTS || 0) : 0, fee_wallet: env.FEE_WALLET || null, token: env.TOKEN_ADDRESS || null, holder_min: Number(env.HOLDER_MIN || 0) });
      if (p === '/v1/stats') return json(await stats(env), 200, { 'cache-control': 'max-age=30' });
      if (p === '/v1/assets') return json(await assets(env, (url.searchParams.get('ids') || '').split(',').filter(isPubkey).slice(0, 100)));
      const m = p.match(/^\/v1\/(will|heir)\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) {
        const seals = (await index(env)).filter((s) => (m[1] === 'will' ? s.owner : s.heir) === m[2]);
        return json({ seals, assets: await assets(env, seals.map((s) => s.mint)), now: Math.floor(Date.now() / 1000) });
      }
      if (p.startsWith('/v1')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : 'internal error' }, e.status || 500);
    }
  },
};
