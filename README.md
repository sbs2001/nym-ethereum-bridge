# Local NYM direct bridge

A local-only Keplr + Ethereum wallet application for native NYM on Nyx → Gravity Bridge → canonical NYM on Ethereum. No app fee, hosted service, private-key entry, or automatic signing. Every state-changing operation is reviewed in the app and approved in the relevant wallet.

## Run

Node 22.12+ and pnpm are recommended:

```sh
cd nym-ethereum-bridge
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://127.0.0.1:8787** in the browser where Keplr and MetaMask are installed. The server deliberately binds only to loopback and accepts that exact host. No cloud deployment is required. Stop it with Ctrl+C. `pnpm dev` runs the development build.

## Workflow

1. Connect Keplr (Nyx and Gravity) and MetaMask (Ethereum mainnet). Complete **Check connection**. Mainnet chains, block freshness, both IBC channels and clients, the canonical NYM mapping, Ethereum decimals, bridge deployment, oracle lag, and the on-chain validator checkpoint are checked. RPC success cannot guarantee future relayer availability.
2. Start with the default **10 NYM** IBC transfer. Review the fee and receiving Gravity address, then approve in Keplr. Keep NYM for Nyx gas. Refresh until Gravity holds the transferred NYM. A confirmed Nyx transaction is not proof of IBC delivery; acknowledgement/timeout tracking appears in Activity where the RPC's event index is available.
3. Enter a **total budget** from the available Gravity balance and an Ethereum receiving address. Review withdrawal. The protocol fee is queried live and calculated using integer micro-NYM. The budget includes that fee; Cosmos gas is additional. The relayer incentive is zero, so execution requires the final relay step (or another willing relayer).
4. Refresh pending transfers; request the NYM batch in Keplr. Refresh again after validators have signed.
5. Choose **Estimate & review relay**. The app verifies enough validator signatures against Ethereum's current checkpoint, builds `submitBatch` locally, and asks your Ethereum wallet to estimate gas. Review the maximum ETH expense and approve the Ethereum transaction. A successful receipt confirms execution. Destinations are fixed when queuing in step 3.
6. If Ethereum needs a newer validator set, the maintenance control prepares a separately reviewed `updateValset`. This has its own gas cost. If no update can be signed by the old Ethereum validator set, the app stops; bridge operators may need to restore the path.

## Fees

Gravity's `min_chain_fee_basis_points` is fetched on each withdrawal preparation and checked again before signing. At 20 basis points, a 750,000 NYM total budget yields **748,502.994012 NYM** and a **1,497.005988 NYM** mandatory fee, before other gas costs. The chain computes its minimum fee with integer truncation.

Nyx's default gas price is 0.025 unym/gas. Gravity's chain registry lists zero as its minimum and average gas price, so the app starts at 0 ugraviton/gas. If the selected node rejects zero fees, fund the Gravity address with GRAV and increase the price. Cosmos gas is simulated, with a 40% gas-limit margin as an initial suggestion. Keplr sets the final gas limit, fee amount, and fee denomination on its approval screen. The app broadcasts those signed values unchanged and records them in Activity. The transfer messages and transaction timeout must still match the reviewed transaction. Keep enough funds for the wallet-selected network fee; the chain rejects an unaffordable fee. Ethereum uses a 20% gas-limit margin and shows `gasLimit × maxFeePerGas` as the maximum. These are estimated limits, not guaranteed costs. No percentage estimate is presented as a live Ethereum quote.

## Recovery and limitations

- Pending Gravity withdrawals and batches are recovered from the connected account's on-chain state. Refresh after any timeout before trying again.
- Public transaction hashes and packet metadata are kept in browser localStorage, not secrets. Export Activity before clearing browser data. Cosmos hashes are stored before broadcasting; ambiguous timeouts remain pending and block another send on that chain. Explicit mempool rejections are marked failed. An expired transaction can be released when its on-chain signer sequence is still unchanged. If sequence advanced but no receipt is indexed, the status deliberately remains unresolved.
- Unbatched withdrawals can be cancelled. Batched ones must expire and return to the unbatched queue first. Do not assume cancellation refunds the already-collected protocol fee.
- IBC timeout refunds depend on an IBC relayer submitting a timeout proof. The app does not run an IBC relayer or generate timeout proofs. Chain/channel checks cannot prove packet delivery in advance.
- Historical Ethereum validator events may be needed if Gravity has pruned a validator set. If your wallet RPC refuses an exact-topic historical query, use a mainnet RPC supporting historical `eth_getLogs`. Failed proof/signature/estimate checks prevent the relay prompt.
- Wallet replacements/cancellations of pending Ethereum transactions may require checking the wallet/explorer manually. The app never treats a missing receipt as proof that a transaction failed.
- This implementation is not independently audited. Automated tests and read-only checks do **not** establish a successful mainnet transfer. Complete a small transfer all the way to Ethereum before using a large amount.

## Configuration

The Node server accepts `PORT`, `NYX_REST`, `NYX_RPC`, `GRAVITY_REST`, and `GRAVITY_RPC` environment variables. Upstream endpoints must be HTTPS. Defaults use Nym's and Gravity's published nodes. The local proxy addresses browser CORS limitations; it has an RPC method allowlist, origin/host checks, no arbitrary destination URL, no credential storage, and no request logging. RPC nodes can still observe public wallet addresses and signed transactions. Ethereum calls use the connected wallet's RPC.

## Validation

```sh
pnpm test
pnpm build
```

Tests cover integer precision, budget/fee rounding invariants, Gravity protobuf encoding against an independently generated schema, Amino conversion, validator signature ordering and rejection, and canonical-token filtering. No test signs or submits a funded transaction.

Sources: [Gravity transaction guide](https://github.com/Gravity-Bridge/Gravity-Docs/blob/main/docs/frontend-creation.md), [message schema](https://github.com/Gravity-Bridge/Gravity-Bridge/blob/main/module/proto/gravity/v1/msgs.proto), [Gravity contract v1.13.4](https://github.com/Gravity-Bridge/Gravity-Bridge/blob/v1.13.4/solidity/contracts/Gravity.sol), [IBC route](https://github.com/cosmos/chain-registry/blob/master/_IBC/gravitybridge-nyx.json), [Gravity fee settings](https://github.com/cosmos/chain-registry/blob/master/gravitybridge/chain.json).
