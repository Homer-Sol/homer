// A will made of Jupiter Lock escrows, built in the browser. HOMER writes no contract and holds nothing.
//   seal     create_vesting_escrow_v2 to the heir: one cliff (the check-in date), only the owner may cancel (cancel_mode 1),
//            only the owner may change the heir (update_recipient_mode 1), plus a metadata account named HOMER so wills can be found
//   unseal   cancel_vesting_escrow before the dawn, then close_vesting_escrow: the tokens and the rent go back to the owner
//   renew    unseal the old escrow and seal a new one with a later dawn, in one transaction
//   heir     update_vesting_escrow_recipient: point the escrow at another heir
//   claim    claim_v2 after the dawn has passed: the heir takes it all
// SOL travels as wrapped SOL and is unwrapped again at the end of each step.
// Works with window.solanaWeb3 in the page and with @solana/web3.js in node (the mainnet simulation).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.HomerWill = factory(root.solanaWeb3);
})(typeof self !== 'undefined' ? self : this, function (web3) {
  const { PublicKey, TransactionInstruction, SystemProgram } = web3;
  const LOCKER = new PublicKey('LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn');
  const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
  // sha256("global:<name>")[0..8], the Anchor instruction tags
  const TAG = {
    create: [181, 155, 104, 183, 182, 128, 35, 47], claim: [229, 87, 46, 162, 21, 157, 231, 114], close: [221, 185, 95, 135, 136, 67, 252, 87],
    cancel: [217, 233, 13, 3, 143, 101, 53, 201], metadata: [93, 78, 33, 103, 173, 125, 70, 0], recipient: [26, 242, 127, 255, 237, 109, 47, 206],
  };
  const NAME = 'HOMER';
  const enc = (s) => new TextEncoder().encode(s);
  const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
  const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const EVENTS = pda([enc('__event_authority')], LOCKER);
  const acc = (pubkey, isSigner, isWritable) => ({ pubkey: pk(pubkey), isSigner, isWritable });

  function bytes(...parts) {
    const list = parts.map((p) => {
      if (typeof p === 'bigint') { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, p, true); return b; }
      if (typeof p === 'string') { const s = enc(p), b = new Uint8Array(4 + s.length); new DataView(b.buffer).setUint32(0, s.length, true); b.set(s, 4); return b; }
      return Uint8Array.from(p);
    });
    const out = new Uint8Array(list.reduce((t, b) => t + b.length, 0));
    let at = 0; for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  }

  const ataOf = (owner, mint, program = TOKEN) => pda([pk(owner).toBytes(), pk(program).toBytes(), pk(mint).toBytes()], ATA);
  const escrowOf = (base) => pda([enc('escrow'), pk(base).toBytes()], LOCKER);
  const metadataOf = (escrow) => pda([enc('escrow_metadata'), pk(escrow).toBytes()], LOCKER);
  const isSol = (mint) => pk(mint).equals(WSOL);

  // create the token account if missing, never fail if it exists
  const openAta = (payer, owner, mint, program) => new TransactionInstruction({
    programId: ATA, data: Uint8Array.from([1]),
    keys: [acc(payer, true, true), acc(ataOf(owner, mint, program), false, true), acc(owner, false, false), acc(mint, false, false), acc(SystemProgram.programId, false, false), acc(program, false, false)],
  });
  // a plain SOL transfer, built by hand: the browser build of web3.js needs Buffer for BigInt amounts
  const transfer = (from, to, lamports) => new TransactionInstruction({ programId: SystemProgram.programId, data: bytes([2, 0, 0, 0], BigInt(lamports)), keys: [acc(from, true, true), acc(to, false, true)] });
  const syncNative = (account) => new TransactionInstruction({ programId: TOKEN, data: Uint8Array.from([17]), keys: [acc(account, false, true)] });
  // closing a wrapped SOL account hands its SOL back to the owner
  const closeAccount = (account, owner) => new TransactionInstruction({ programId: TOKEN, data: Uint8Array.from([9]), keys: [acc(account, false, true), acc(owner, false, true), acc(owner, true, false)] });

  // { owner, heir, mint, program, amount (raw), dawn (unix seconds), base (fresh keypair's key), now }
  // wrap: false when the SOL already sits in the owner's wrapped SOL account (a renewal)
  function seal({ owner, heir, mint, program = TOKEN, amount, dawn, base, now, wrap = true }) {
    const start = now ?? Math.floor(Date.now() / 1000);
    if (!(BigInt(amount) > 0n)) throw new Error('nothing to leave');
    if (!(dawn > start)) throw new Error('the dawn must be in the future');
    if (pk(heir).equals(pk(owner))) throw new Error('the heir must be another wallet');
    const escrow = escrowOf(base), sol = isSol(mint), source = ataOf(owner, mint, program);
    const ixs = [];
    if (sol && wrap) ixs.push(openAta(owner, owner, WSOL, TOKEN), transfer(owner, source, amount), syncNative(source));
    ixs.push(
      openAta(owner, escrow, mint, program),
      new TransactionInstruction({
        programId: LOCKER,
        // vesting_start_time, cliff_time, frequency, cliff_unlock_amount, amount_per_period, number_of_period,
        // update_recipient_mode 1 (owner), cancel_mode 1 (owner), no remaining accounts
        data: bytes(TAG.create, BigInt(start), BigInt(dawn), 1n, BigInt(amount), 0n, 0n, [1, 1, 0]),
        keys: [
          acc(base, true, true), acc(escrow, false, true), acc(mint, false, false), acc(ataOf(escrow, mint, program), false, true),
          acc(owner, true, true), acc(source, false, true), acc(heir, false, false),
          acc(program, false, false), acc(SystemProgram.programId, false, false), acc(EVENTS, false, false), acc(LOCKER, false, false),
        ],
      }),
      new TransactionInstruction({
        programId: LOCKER,
        // emails stay empty: everything here is public on chain
        data: bytes(TAG.metadata, NAME, 'will', '', ''),
        keys: [acc(escrow, false, true), acc(owner, true, false), acc(metadataOf(escrow), false, true), acc(owner, true, true), acc(SystemProgram.programId, false, false)],
      }),
    );
    if (sol) ixs.push(closeAccount(source, owner));
    return { escrow, ixs };
  }

  // e: a decoded escrow (readEscrow). The heir's token account must exist for cancel, so it is opened if missing.
  // close_vesting_escrow after a cancel: the escrow and its metadata hand their rent back to the owner
  const closeEscrow = ({ owner, e }) => {
    const program = e.token_2022 ? TOKEN_2022 : TOKEN;
    return new TransactionInstruction({
      programId: LOCKER, data: bytes(TAG.close, [0]),
      keys: [acc(e.escrow, false, true), acc(metadataOf(e.escrow), false, true), acc(e.mint, false, true), acc(ataOf(e.escrow, e.mint, program), false, true), acc(ataOf(owner, e.mint, program), false, true), acc(owner, true, true), acc(program, false, false), acc(MEMO, false, false), acc(EVENTS, false, false), acc(LOCKER, false, false)],
    });
  };

  function unseal({ owner, e }) {
    const program = e.token_2022 ? TOKEN_2022 : TOKEN, sol = isSol(e.mint);
    const mine = ataOf(owner, e.mint, program);
    const ixs = [
      openAta(owner, owner, e.mint, program), openAta(owner, e.recipient, e.mint, program),
      new TransactionInstruction({
        programId: LOCKER, data: bytes(TAG.cancel, [0]),
        keys: [acc(e.escrow, false, true), acc(e.mint, false, true), acc(ataOf(e.escrow, e.mint, program), false, true), acc(mine, false, true), acc(ataOf(e.recipient, e.mint, program), false, true), acc(owner, false, true), acc(owner, true, true), acc(MEMO, false, false), acc(program, false, false), acc(EVENTS, false, false), acc(LOCKER, false, false)],
      }),
      closeEscrow({ owner, e }),
    ];
    if (sol) ixs.push(closeAccount(mine, owner));
    return ixs;
  }

  // the old escrow comes back and a new one goes out with a later dawn, same heir, same amount.
  // Wrapped SOL that comes back is sealed again as it is and unwrapped only if anything is left.
  function renew({ owner, e, dawn, base, now }) {
    const program = e.token_2022 ? TOKEN_2022 : TOKEN, sol = isSol(e.mint);
    const back = unseal({ owner, e });
    if (sol) back.pop();
    const amount = e.total - e.claimed;
    const out = seal({ owner, heir: e.recipient, mint: e.mint, program, amount, dawn, base, now, wrap: false });
    return { escrow: out.escrow, ixs: [...back, ...out.ixs] };
  }

  function changeHeir({ owner, e, heir }) {
    if (pk(heir).equals(pk(owner))) throw new Error('the heir must be another wallet');
    return [new TransactionInstruction({
      programId: LOCKER, data: bytes(TAG.recipient, pk(heir).toBytes(), [0]),
      keys: [acc(e.escrow, false, true), acc(metadataOf(e.escrow), false, true), acc(owner, true, true), acc(SystemProgram.programId, false, false), acc(EVENTS, false, false), acc(LOCKER, false, false)],
    })];
  }

  // payer: someone else may pay the fee and the token account rent, for an heir whose wallet is empty
  function claim({ heir, e, payer = heir }) {
    const program = e.token_2022 ? TOKEN_2022 : TOKEN, mine = ataOf(heir, e.mint, program);
    const ixs = [
      openAta(payer, heir, e.mint, program),
      new TransactionInstruction({
        programId: LOCKER, data: bytes(TAG.claim, 0xffffffffffffffffn, [0]),
        keys: [acc(e.escrow, false, true), acc(e.mint, false, false), acc(ataOf(e.escrow, e.mint, program), false, true), acc(heir, true, true), acc(mine, false, true), acc(MEMO, false, false), acc(program, false, false), acc(EVENTS, false, false), acc(LOCKER, false, false)],
      }),
    ];
    if (isSol(e.mint)) ixs.push(closeAccount(mine, heir));
    return ixs;
  }

  // VestingEscrow after its 8-byte tag: recipient, mint, creator, base, then flags and u64s
  function readEscrow(escrow, data) {
    const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const key = (o) => new PublicKey(b.subarray(o, o + 32));
    const u64 = (o) => v.getBigUint64(o, true);
    const e = {
      escrow: pk(escrow), recipient: key(8), mint: key(40), creator: key(72),
      update_recipient_mode: b[137], cancel_mode: b[138], token_2022: b[139] === 1,
      cliff_time: Number(u64(144)), cliff_unlock: u64(160), per_period: u64(168), periods: u64(176),
      claimed: u64(184), start: Number(u64(192)), cancelled_at: Number(u64(200)),
    };
    e.total = e.cliff_unlock + e.per_period * e.periods;
    return e;
  }
  // VestingEscrowMetadata: tag, escrow, then name as a borsh string
  function readMetadata(data) {
    const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const len = new DataView(b.buffer, b.byteOffset).getUint32(40, true);
    return { escrow: new PublicKey(b.subarray(8, 40)), name: new TextDecoder().decode(b.subarray(44, 44 + len)) };
  }

  return { LOCKER, TOKEN, TOKEN_2022, WSOL, NAME, transfer, seal, unseal, closeEscrow, renew, changeHeir, claim, readEscrow, readMetadata, ataOf, escrowOf, metadataOf };
});
