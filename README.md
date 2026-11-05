# HOMER

If I don't come home, the bird flies.

HOMER is a will for your Solana wallet. You leave SOL or tokens to someone as a "letter", check in now and then with one signature, and if you ever stop, the letter is delivered and they collect it.

- Site: https://homersol.fun
- X: https://x.com/homerdotfun

## How it works

A letter is a [Jupiter Lock](https://docs.jup.ag/user-docs/more/security) escrow (program `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`). Jupiter Lock was audited by OtterSec and Sec3 in August 2024.

| Setting | Value |
|---|---|
| Recipient | the person you chose |
| Unlock | everything at one moment: your check-in date (30, 90, 180 or 365 days out) |
| `cancel_mode` | 1: only you can cancel |
| `update_recipient_mode` | 1: only you can change the recipient |
| Metadata | a `VestingEscrowMetadata` account named `HOMER`, so the site can find letters |

- **Write:** `create_vesting_escrow_v2` plus `create_vesting_escrow_metadata`. SOL is wrapped for the escrow first.
- **Take back:** `cancel_vesting_escrow` returns everything to you, then `close_vesting_escrow` returns the rent.
- **Check in ("I'm home"):** take back and write again with a new date, in one transaction per letter. Each letter keeps its own gap.
- **Change recipient:** `update_vesting_escrow_recipient`.
- **Collect:** after the date, the recipient calls `claim_v2`. SOL is unwrapped. Someone else can pay the fee for an empty wallet.

HOMER has no program and holds no keys or funds. The page builds every transaction in your browser and your wallet signs it. If the site goes away, the escrows are still in Jupiter Lock and any tool that speaks to it can cancel or claim them.

Everything in a letter is public on chain. This is not a legal will.

## Postage

A new letter costs 0.01 SOL, sent in the same transaction to `F3VkvigoSvaCjmLHYtZAscnay78KGo1ZmwyZoALJRdr6`. All of it is used to buy back $HOMER. Holders of $HOMER post letters for free. Checking in is always free.

## Layout

```
will/     will.js: every instruction, one file for the browser and node
          check.mjs: simulates every step against mainnet with real accounts
worker/   Cloudflare Worker: serves the site, /rpc allowlist, /v1 index of letters
site/     the page (index.html)
brand/    render.html draws the avatar, X header and link image
```

## Check it yourself

```bash
cd will
npm install
RPC=<mainnet RPC url> node check.mjs
```

`check.mjs` signs nothing and sends nothing. It builds each transaction with `will.js` and runs `simulateTransaction` against mainnet: writing a SOL letter and a Token-2022 letter, taking letters back on real cancellable escrows, a full check-in in one transaction, changing the recipient, the recipient failing to change it, and a recipient collecting SOL after the date. Your RPC must allow `getProgramAccounts`.

## Deploy

```bash
cp will/will.js site/will.js
cd worker
npx wrangler secret put SOL_RPC_URL   # a mainnet RPC with getProgramAccounts and the DAS API
npx wrangler deploy
```

Settings are in `worker/wrangler.jsonc`: `FEE_LAMPORTS`, `FEE_WALLET`, `TOKEN_ADDRESS`, `HOLDER_MIN`.

## License

MIT
