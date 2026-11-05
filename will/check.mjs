// Mainnet simulation of every step of will.js on real accounts. No keys and no funds: signatures are not checked.
// Run: npm install, then RPC=<mainnet RPC url> node check.mjs (getProgramAccounts must be allowed)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const K = require('./will.js')(web3);
const { PublicKey, Connection, TransactionMessage, VersionedTransaction, Keypair, ComputeBudgetProgram, TransactionInstruction } = web3;

const c = new Connection(process.env.RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const budget = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 60000 })];

async function simulate(payer, ixs, watch = [], signers = []) {
  const { blockhash } = await c.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budget(), ...ixs] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const size = tx.serialize().length;
  const r = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: watch.map(String) } });
  const after = (r.value.accounts || []).map((a) => { if (!a || a.lamports === 0) return 'closed'; const d = Buffer.from(a.data[0], 'base64'); return d.length >= 165 && a.owner !== K.LOCKER.toBase58() ? BigInt(d.readBigUInt64LE(64)) : { lamports: a.lamports }; });
  return { err: r.value.err, size, units: r.value.unitsConsumed, logs: (r.value.logs || []).filter((l) => /rror|failed/.test(l)).slice(-2), after };
}
const show = (r) => (r.err ? `err ${JSON.stringify(r.err)} ${r.logs.join(' ')}` : `size ${r.size}/1232 bytes, ${r.units} CU`);

const escrows = async (filters) => (await c.getProgramAccounts(K.LOCKER, { filters: [{ dataSize: 296 }, ...filters] })).map((g) => K.readEscrow(g.pubkey, g.account.data));
const memcmp = (offset, buf) => ({ memcmp: { offset, bytes: bs58.encode(Buffer.from(buf)) } });

// --- 1 seal SOL: a wallet with SOL leaves 0.5 SOL to a fresh heir, dawn in 180 days
{
  const owner = new PublicKey(process.env.SOL_OWNER || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
  const heir = Keypair.generate().publicKey, base = Keypair.generate();
  const { escrow, ixs } = K.seal({ owner, heir, mint: K.WSOL, amount: 500000000n, dawn: now + 180 * DAY, base: base.publicKey, now });
  const before = await c.getBalance(owner);
  const r = await simulate(owner, ixs, [K.ataOf(escrow, K.WSOL), K.ataOf(owner, K.WSOL), owner, K.metadataOf(escrow), escrow]);
  ok('1 seal 0.5 SOL', !r.err && r.after[0] === 500000000n && r.after[1] === 'closed', `${show(r)} | escrow holds ${r.after[0]}, owner wSOL ${r.after[1]}, metadata ${r.after[3]?.lamports ? 'written' : 'missing'}`);
}

// --- 2 seal Token-2022 for a holder who holds now
{
  const MINT = new PublicKey(process.env.MINT || '4kKehjYsFdzb1SdT9xCv5LCUKP5oa1uLGjH9LckZpump');
  const holders = (process.env.HOLDERS || '').split(',').filter(Boolean);
  // with a full RPC the largest holders can be read directly
  try { for (const l of (await c.getTokenLargestAccounts(MINT)).value.slice(0, 10)) { const i = await c.getParsedAccountInfo(l.address); holders.push(i.value.data.parsed.info.owner); } } catch {}
  let done = false;
  for (const h of holders) {
    const owner = new PublicKey(h), src = K.ataOf(owner, MINT, K.TOKEN_2022);
    const info = await c.getAccountInfo(src);
    const sys = await c.getAccountInfo(owner);
    if (!info || !sys || !sys.owner.equals(web3.SystemProgram.programId) || sys.lamports < 0.01e9) continue;
    const have = info.data.readBigUInt64LE(64);
    if (have === 0n) continue;
    const base = Keypair.generate(), heir = Keypair.generate().publicKey;
    const { escrow, ixs } = K.seal({ owner, heir, mint: MINT, program: K.TOKEN_2022, amount: have / 2n, dawn: now + 90 * DAY, base: base.publicKey, now });
    const r = await simulate(owner, ixs, [K.ataOf(escrow, MINT, K.TOKEN_2022), src, K.metadataOf(escrow)]);
    const meta = r.after[2]?.lamports ? 'metadata written' : 'no metadata';
    ok('2 seal half a Token-2022 bag', !r.err && r.after[0] === have / 2n, `${show(r)} | escrow ${r.after[0]}, owner ${r.after[1]}, ${meta}`);
    done = true; break;
  }
  if (!done) ok('2 seal Token-2022', false, 'no holder with a balance in HOLDERS');
}

// --- 3-5 on real escrows the creator can cancel and re-point
console.log('\nreading escrows the creator can cancel and re-point (modes 1/1)…');
const live = (await escrows([memcmp(137, [1, 1]), memcmp(200, Buffer.alloc(8))])).filter((e) => !e.recipient.equals(e.creator));
console.log(`${live.length} found`);
const ahead = [];
for (const e of live.filter((e) => e.cliff_time > now + 7 * DAY).slice(0, 40)) {
  const prog = e.token_2022 ? K.TOKEN_2022 : K.TOKEN;
  const t = await c.getAccountInfo(K.ataOf(e.escrow, e.mint, prog));
  if (t && t.data.readBigUInt64LE(64) > 0n && (await c.getBalance(e.creator)) > 0.02e9) ahead.push(e);
  if (ahead.length >= 2) break;
}
for (const e of ahead) {
  const prog = e.token_2022 ? K.TOKEN_2022 : K.TOKEN, mine = K.ataOf(e.creator, e.mint, prog);
  const r3 = await simulate(e.creator, K.unseal({ owner: e.creator, e }), [K.ataOf(e.escrow, e.mint, prog), mine, e.escrow]);
  ok(`3 unseal ${e.escrow.toBase58().slice(0, 6)} (${e.token_2022 ? 'Token-2022' : 'Token'}${K.WSOL.equals(e.mint) ? ', SOL' : ''})`, !r3.err && r3.after[0] === 'closed' && r3.after[2] === 'closed', `${show(r3)} | escrow token ${r3.after[0]}, owner after ${typeof r3.after[1] === 'bigint' ? r3.after[1] : JSON.stringify(r3.after[1])}, escrow account ${r3.after[2] === 'closed' ? 'closed' : 'still open (' + r3.after[2].lamports + ' lamports)'}`);

  const base = Keypair.generate();
  const rn = K.renew({ owner: e.creator, e, dawn: now + 180 * DAY, base: base.publicKey, now });
  const r4 = await simulate(e.creator, rn.ixs, [K.ataOf(rn.escrow, e.mint, prog), K.ataOf(e.escrow, e.mint, prog)]);
  ok(`4 renew ${e.escrow.toBase58().slice(0, 6)} in one transaction`, !r4.err && r4.after[0] === e.total - e.claimed && r4.after[1] === 'closed', `${show(r4)} | new escrow holds ${r4.after[0]}`);

  const heir = Keypair.generate().publicKey;
  const r5 = await simulate(e.creator, K.changeHeir({ owner: e.creator, e, heir }), [e.escrow]);
  ok(`5 change heir on ${e.escrow.toBase58().slice(0, 6)}`, !r5.err, show(r5));
  const r5b = await simulate(e.recipient, K.changeHeir({ owner: e.recipient, e, heir }), []);
  ok('5b the heir cannot re-point it', !!r5b.err, r5b.err ? 'refused' : 'ALLOWED');
}
if (!ahead.length) ok('3-5 found an escrow to test on', false);

// --- 6 claim after the dawn, SOL if one exists
{
  const sol = (await escrows([memcmp(40, K.WSOL.toBytes()), memcmp(138, [1]), memcmp(200, Buffer.alloc(8))])).filter((e) => e.cliff_time < now && e.total > e.claimed && !e.recipient.equals(e.creator));
  const pool = sol.length ? sol : live.filter((e) => e.cliff_time < now && e.total > e.claimed);
  let tried = 0;
  for (const e of pool) {
    const prog = e.token_2022 ? K.TOKEN_2022 : K.TOKEN;
    const t = await c.getAccountInfo(K.ataOf(e.escrow, e.mint, prog));
    if (!t || t.data.readBigUInt64LE(64) === 0n) continue;
    const before = await c.getBalance(e.recipient);
    // an heir with no SOL cannot pay the fee: then another wallet pays it
    const payer = before > 0.005e9 ? e.recipient : new PublicKey(process.env.SOL_OWNER || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
    const r = await simulate(payer, K.claim({ heir: e.recipient, e, payer }), [K.ataOf(e.escrow, e.mint, prog), e.recipient, K.ataOf(e.recipient, e.mint, prog)]);
    const isSol = K.WSOL.equals(e.mint);
    ok(`6 heir claims after the dawn (${isSol ? 'SOL, unwrapped' : 'token'}${payer.equals(e.recipient) ? '' : ', another wallet pays the fee'})`, !r.err, `${show(r)} | escrow token after ${r.after[0]}${isSol ? `, heir SOL +${((r.after[1]?.lamports || 0) - before) / 1e9}, heir wSOL ${r.after[2]}` : ''}`);
    if (++tried >= 1) break;
  }
  if (!tried) ok('6 found an escrow past its dawn', false);
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
