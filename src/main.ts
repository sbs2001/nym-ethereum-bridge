import './style.css';
import { formatEther, getAddress, Contract } from 'ethers';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { api, BRIDGE, budgetQuote, DENOM, formatNym, NYM, ownNymTransfer, parseNym, sameAddress, type Batch, type Transfer } from './core';
import { CancelSend, RequestBatch, SendToEth } from './messages';
import { assertCosmosAccount, balance, connectCosmos, extractPacket, history, record, sendCosmos, simulate, type Chain, type CosmosWallet } from './cosmos';
import { abi, assertEthAccount, connectEthereum, estimateEthereum, prepareBatch, prepareValsetUpdate, type EthWallet } from './ethereum';
import { checkRoute } from './health';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header><a aria-label="NYM Thesis home" class="brand" href="https://nymthesis.xyz/"><span class="brand-mark" aria-hidden="true">↗</span> NYM<span class="wordmark-divider">/</span><span class="wordmark-sub">THESIS</span></a><span class="network-pill">ETHEREUM MAINNET</span></header>
<main><section class="intro"><p class="eyebrow">A SIMPLE, DIRECT ROUTE</p><h1>Bridge NYM<br>to Ethereum.</h1><p>Three steps. Your NYM stays NYM, with wallet approval at every step.</p></section>
<section class="walletbar" aria-label="Wallet connections"><div class="wallet-card"><div><small>NYX + GRAVITY</small><p id="cosmos-account">Connect Keplr to continue</p></div><button id="keplr" class="wallet-button">Connect Keplr</button></div><div class="wallet-card"><div><small>ETHEREUM</small><p id="eth-account">Connect a wallet to receive NYM</p></div><button id="metamask" class="wallet-button">Connect wallet</button></div></section>
<div id="notice" role="status" aria-live="polite">Connect Keplr and your Ethereum wallet to get started. Review every amount and address in your wallets before approving.</div>
<div class="steps">
<section class="card"><div class="stephead"><span class="number">1</span><div><h2>Move NYM from Nyx</h2><p>Skip this step if your NYM is already on Gravity.</p></div></div><label for="ibc-amount">Amount to move</label><div class="inputrow"><input id="ibc-amount" inputmode="decimal" value="10" autocomplete="off"><span>NYM</span></div><p id="nyx-balance" class="sub">Connect Keplr to see your available balance.</p><button id="ibc" class="primary">Review Nyx transfer <span aria-hidden="true">→</span></button><p class="hint">Keep a little NYM on Nyx to cover its network fee. Transfers may take a few minutes.</p></section>
<section class="card"><div class="stephead"><span class="number">2</span><div><h2>Choose how much to bridge</h2><p>Set the total amount to use from your Gravity balance.</p></div></div><label for="budget">Total amount, including protocol fee</label><div class="inputrow"><input id="budget" inputmode="decimal" value="10" autocomplete="off"><span>NYM</span></div><p id="gravity-balance" class="sub">Connect Keplr to see your available balance.</p><label for="destination">Ethereum receiving address</label><input id="destination" placeholder="0x…" autocomplete="off" spellcheck="false"><button id="use-address" class="textbutton">Use my connected wallet address</button><div id="quote" class="quote">Connect your Ethereum wallet to see the live fee and estimate.</div><button id="queue" class="primary">Review bridge request <span aria-hidden="true">→</span></button><p class="hint">The quote shows how much NYM will arrive. Ethereum gas is paid separately in ETH.</p></section>
<section class="card"><div class="stephead"><span class="number">3</span><div><h2>Complete the transfer</h2><p>Once your request is batched, send it to Ethereum and pay gas in ETH.</p></div></div><button id="refresh" class="secondary-action">Check transfer status ↻</button><div id="pending" class="pending">Connect your wallets to check for pending transfers.</div></section>
</div>
<details class="advanced"><summary>Advanced settings, fees &amp; activity</summary><div class="advanced-grid"><section class="card"><h3>Fees and route details</h3><p class="advanced-rate"><span id="rate">—</span> protocol fee</p><dl><dt>App fee</dt><dd>0 NYM</dd><dt>Relayer commission</dt><dd>0 NYM</dd><dt>Ethereum gas</dt><dd>Quoted before signing</dd><dt>Cosmos network fee</dt><dd>Set in Keplr</dd></dl><button id="check" class="textbutton">Check bridge connection ↻</button><p id="health" class="hint">Connection checks run automatically before a transfer.</p></section><section class="card"><h3>Network fee estimates</h3><label for="nyx-gas">Nyx gas price (unym / gas)</label><input id="nyx-gas" value="0.025" inputmode="decimal"><label for="gravity-gas">Gravity gas price (ugraviton / gas)</label><input id="gravity-gas" value="0" inputmode="decimal"><p class="hint">These values estimate the fee. Keplr sets the final gas and fee when you approve; your node may require a minimum.</p></section><section class="card"><h3>Validator maintenance</h3><p class="hint">A validator update is only needed when the relay requests a newer validator set. It is a separate Ethereum transaction with its own gas cost.</p><button id="valset">Review validator update</button></section><section class="card"><h3>Transfer activity</h3><button id="export" class="textbutton">Export activity JSON ↓</button><div id="history" class="activity">No transactions yet.</div></section></div></details>
<footer><p>Native NYM on Nyx → NYM on Ethereum</p><a href="https://github.com/Gravity-Bridge/Gravity-Docs/blob/main/docs/frontend-creation.md" target="_blank" rel="noreferrer">How the bridge works ↗</a></footer></main>
<dialog id="review"><form method="dialog"><button class="close" aria-label="Close review">×</button></form><p class="eyebrow">CHECK BEFORE APPROVING</p><h2 id="review-title"></h2><pre id="review-body"></pre><details id="review-advanced" hidden><summary>Technical transaction data</summary><pre id="review-technical"></pre></details><p class="review-note">Your wallet will ask you to approve this transaction. Closing this window sends nothing.</p><button id="confirm" class="primary">Continue to wallet <span aria-hidden="true">→</span></button></dialog>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id).value.trim();
const text = (id: string, value: string) => { $(id).textContent = value; };
const shortAddress = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
let nyx: CosmosWallet | undefined, gravity: CosmosWallet | undefined, eth: EthWallet | undefined;
let route: Awaited<ReturnType<typeof checkRoute>> | undefined;
let busy = false;
let reviewAction: (() => Promise<void>) | undefined;
const dialog = $<HTMLDialogElement>('review');
function notice(message: string, error = false) { text('notice', message); $('notice').classList.toggle('error', error); }
async function task(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { await fn(); } catch (e: any) { notice(e.shortMessage || e.message || String(e), true); }
  finally { busy = false; document.body.classList.remove('busy'); document.querySelectorAll('button').forEach(b => { b.disabled = false; }); renderHistory(); }
}
function on(id: string, fn: () => Promise<void>) { $(id).addEventListener('click', () => { void task(fn); }); }
function review(title: string, body: string, action: () => Promise<void>, technical = '') {
  text('review-title', title); text('review-body', body); text('review-technical', technical);
  $('review-advanced').hidden = !technical; reviewAction = action; dialog.showModal();
}
dialog.addEventListener('close', () => { reviewAction = undefined; });
on('confirm', async () => { const action = reviewAction; dialog.close(); if (action) { notice('Waiting for wallet approval or network confirmation…'); await action(); } });

function wallets() {
  if (!nyx || !gravity || !eth) throw Error('Connect Keplr and your Ethereum wallet first.');
  return { nyx, gravity, eth };
}
async function check() {
  route = undefined; text('health', 'Checking chain, channel, token and relay state…');
  try { route = await checkRoute(eth); text('health', route.ethInfo); text('rate', `${Number(route.bps) / 100}%`); updateQuote(); }
  catch (e) { text('health', 'Route check failed'); throw e; }
}
function updateQuote() {
  if (!route) return;
  try {
    const q = budgetQuote(parseNym(input('budget')), route.bps);
    text('quote', `Receive ${formatNym(q.receive)} NYM on Ethereum\nProtocol fee ${formatNym(q.chainFee)} NYM\nTotal NYM ${formatNym(q.total)} + network gas`);
  } catch (e: any) { text('quote', e.message); }
}
$('budget').addEventListener('input', updateQuote);
on('keplr', async () => {
  nyx = await connectCosmos('nyx'); gravity = await connectCosmos('gravity');
  text('cosmos-account', `Nyx  ${shortAddress(nyx.address)}\nGravity  ${shortAddress(gravity.address)}`);
  $('cosmos-account').title = `Nyx: ${nyx.address}\nGravity: ${gravity.address}`;
  text('keplr', 'Keplr connected ✓');
  await refresh(); notice('Keplr connected. Wallet addresses and pending transfers loaded.');
});
on('metamask', async () => {
  eth = await connectEthereum();
  eth.injected.on?.('accountsChanged', invalidateEthereum); eth.injected.on?.('chainChanged', invalidateEthereum);
  text('eth-account', shortAddress(eth.address)); $('eth-account').title = eth.address;
  text('metamask', 'Wallet connected ✓');
  if (!input('destination')) $<HTMLInputElement>('destination').value = eth.address;
  await check(); notice('Ethereum wallet connected. Route checks passed.');
});
function invalidateEthereum() { eth = undefined; route = undefined; dialog.close(); text('metamask', 'Reconnect wallet'); text('eth-account', 'Wallet account or network changed'); $('eth-account').title = ''; notice('Your Ethereum wallet changed. Reconnect it before continuing.'); }
window.addEventListener('keplr_keystorechange', () => { nyx?.client.disconnect(); gravity?.client.disconnect(); nyx = gravity = undefined; route = undefined; dialog.close(); text('keplr', 'Reconnect Keplr'); text('cosmos-account', 'Wallet account changed'); $('cosmos-account').title = ''; notice('Your Keplr account changed. Reconnect it before continuing.'); });
on('check', check);
on('use-address', async () => { if (!eth) throw Error('Connect Ethereum first.'); $<HTMLInputElement>('destination').value = eth.address; });
function gasPrice(chain: Chain) {
  const raw = input(chain === 'nyx' ? 'nyx-gas' : 'gravity-gas');
  if (!/^\d+(\.\d{1,9})?$/.test(raw)) throw Error('Invalid Cosmos gas price.');
  return raw + (chain === 'nyx' ? 'unym' : 'ugraviton');
}
function feeText(chain: Chain, fee: any) {
  const amount = BigInt(fee.amount[0]?.amount || '0');
  return `${formatNym(amount)} ${chain === 'nyx' ? 'NYM' : 'GRAV'} (gas limit ${fee.gas})`;
}
async function noPending(chain: Chain | 'ethereum', account: string) {
  await reconcile();
  if (history().some(x => x.chain === chain && sameAddress(x.account, account) && x.status === 'pending')) throw Error('A transaction from this wallet is still unconfirmed. Refresh its status before submitting another.');
}
async function cosmosReview(chain: Chain, msgs: EncodeObject[], title: string, description: string, spending: bigint, recheck: () => Promise<void>) {
  const w = chain === 'nyx' ? wallets().nyx : wallets().gravity;
  await noPending(chain, w.address);
  const fee = await simulate(w, msgs, gasPrice(chain));
  const tokenBalance = await balance(chain, w.address, chain === 'nyx' ? 'unym' : DENOM);
  if (tokenBalance < spending) throw Error('Insufficient spendable NYM for this transfer.');
  const prepared = Date.now();
  review(title, `${description}\n\nWallet: ${w.address}\nEstimated network fee: ${feeText(chain, fee)}\nKeplr will show the final fee before you approve. Keep enough tokens to cover it.`, async () => {
    if (Date.now() - prepared > 120_000) throw Error('Review expired. Prepare a fresh transaction.');
    await assertCosmosAccount(chain, w); await noPending(chain, w.address); await recheck();
    const result = await sendCosmos(chain, w, msgs, fee, title);
    notice(`Confirmed on ${chain}: ${result.transactionHash}${chain === 'nyx' ? '. IBC delivery is a separate step; wait for your Gravity balance to increase.' : ''}`);
    await refresh();
  }, JSON.stringify(msgs, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}
on('ibc', async () => {
  const w = wallets(); await check();
  const amount = parseNym(input('ibc-amount'));
  const msg = { typeUrl: '/ibc.applications.transfer.v1.MsgTransfer', value: { sourcePort: 'transfer', sourceChannel: 'channel-0', token: { denom: 'unym', amount: amount.toString() }, sender: w.nyx.address, receiver: w.gravity.address, timeoutHeight: { revisionNumber: 0n, revisionHeight: 0n }, timeoutTimestamp: BigInt(Date.now() + 30 * 60_000) * 1_000_000n, memo: '' } };
  await cosmosReview('nyx', [msg], 'Move NYM to Gravity', `Move ${formatNym(amount)} NYM from your Nyx wallet to your Gravity wallet. IBC delivery may take a few minutes.`, amount, async () => { await check(); if (wallets().gravity.address !== w.gravity.address) throw Error('Receiving wallet changed.'); });
});
on('queue', async () => {
  const w = wallets(); await check();
  const destination = getAddress(input('destination'));
  if (sameAddress(destination, BRIDGE) || sameAddress(destination, NYM) || /^0x0{40}$/i.test(destination)) throw Error('Use your Ethereum receiving wallet, not a bridge/token contract or zero address.');
  if (route!.blacklist.some(a => sameAddress(a, destination))) throw Error('Gravity does not allow this destination.');
  const bps = route!.bps, q = budgetQuote(parseNym(input('budget')), bps);
  if (q.receive === 0n) throw Error('Budget is too small.');
  const msg = { typeUrl: SendToEth.typeUrl, value: { sender: w.gravity.address, ethDest: destination, amount: { denom: DENOM, amount: q.receive.toString() }, bridgeFee: { denom: DENOM, amount: '0' }, chainFee: { denom: DENOM, amount: q.chainFee.toString() } } };
  await cosmosReview('gravity', [msg], 'Queue NYM for Ethereum', `Receive: ${formatNym(q.receive)} NYM\nDestination: ${destination}\nProtocol fee: ${formatNym(q.chainFee)} NYM (${Number(bps) / 100}%)\nRelayer commission: 0 NYM\nETH relay gas is additional. The protocol fee is charged now and may not be refunded on cancellation.`, q.total, async () => { await check(); if (route!.bps !== bps) throw Error('Protocol fee changed. Prepare again.'); });
});

async function getPending() {
  if (!gravity) return { unbatched: [] as Transfer[], batched: [] as Batch[] };
  const [p, b] = await Promise.all([
    api('gravity', `/gravity/v1beta/query_pending_send_to_eth?sender_address=${gravity.address}`),
    api('gravity', '/gravity/v1beta/batch/outgoingtx'),
  ]);
  return { unbatched: (p.unbatched_transfers || []).filter((t: Transfer) => ownNymTransfer(t, gravity!.address)) as Transfer[], batched: (b.batches || []).filter((batch: Batch) => sameAddress(batch.token_contract, NYM) && batch.transactions.some(t => ownNymTransfer(t, gravity!.address))) as Batch[] };
}
async function refresh() {
  await reconcile();
  if (nyx && gravity) {
    const balances = await Promise.allSettled([balance('nyx', nyx.address, 'unym'), balance('gravity', gravity.address, DENOM)]);
    const [n, g] = balances;
    text('nyx-balance', n.status === 'fulfilled' ? `Available on Nyx: ${formatNym(n.value)} NYM` : 'Nyx balance unavailable');
    text('gravity-balance', g.status === 'fulfilled' ? `Available on Gravity: ${formatNym(g.value)} NYM` : 'Gravity balance unavailable');
    const p = await getPending(); renderPending(p);
  }
  renderHistory();
}
on('refresh', refresh);
function actionButton(label: string, fn: () => Promise<void>) {
  const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', () => void task(fn)); return b;
}
function renderPending(p: Awaited<ReturnType<typeof getPending>>) {
  const box = $('pending'); box.replaceChildren();
  if (!p.unbatched.length && !p.batched.length) { box.textContent = 'No pending NYM withdrawals for this Gravity wallet. Transferred NYM appears in your balance above.'; return; }
  for (const t of p.unbatched) {
    const item = document.createElement('article'); const description = document.createElement('p');
    description.textContent = `${formatNym(BigInt(t.erc20_token.amount))} NYM · waiting for validators to prepare a batch`;
    item.append(description, actionButton('Request a batch', async () => {
      const w = wallets();
      await cosmosReview('gravity', [{ typeUrl: RequestBatch.typeUrl, value: { sender: w.gravity.address, denom: DENOM } }], 'Request NYM batch', `Includes queued NYM transfers; validators must sign before relay.\nYour transfer: #${t.id}`, 0n, async () => { if (!(await getPending()).unbatched.some(x => x.id === t.id)) throw Error('Transfer is no longer unbatched. Refresh.'); });
    }), actionButton('Cancel withdrawal', async () => {
      const w = wallets();
      await cosmosReview('gravity', [{ typeUrl: CancelSend.typeUrl, value: { transactionId: BigInt(t.id), sender: w.gravity.address } }], 'Cancel queued withdrawal', `Cancel #${t.id}. Returns the queued amount and relay fee to Gravity. The already-paid protocol fee may not be returned.`, 0n, async () => { if (!(await getPending()).unbatched.some(x => x.id === t.id)) throw Error('Transfer was batched; cancellation must wait until its batch expires.'); });
    })); box.append(item);
  }
  for (const batch of p.batched) {
    const item = document.createElement('article'); const description = document.createElement('p');
    const own = batch.transactions.filter(t => ownNymTransfer(t, gravity!.address));
    description.textContent = `Batch #${batch.batch_nonce}\n${own.map(t => `${formatNym(BigInt(t.erc20_token.amount))} NYM → ${t.dest_address}`).join('\n')}\nTimeout at Ethereum block ${batch.batch_timeout}`;
      item.append(description, actionButton('Review Ethereum transfer', async () => {
      const w = wallets();
      const fresh = (await getPending()).batched.find(b => b.batch_nonce === batch.batch_nonce);
      if (!fresh) throw Error('Batch no longer pending. Refresh.');
      const data = await prepareBatch(w.eth, fresh);
      await ethReview(`Relay NYM batch #${fresh.batch_nonce}`, data, own.map(t => `${formatNym(BigInt(t.erc20_token.amount))} NYM → ${t.dest_address}`).join('\n'), async () => {
        const b = (await getPending()).batched.find(x => x.batch_nonce === fresh.batch_nonce);
        if (!b || await prepareBatch(w.eth, b) !== data) throw Error('Batch or signatures changed. Prepare a fresh relay.');
      });
    })); box.append(item);
  }
}
async function ethReview(title: string, data: string, description: string, recheck: () => Promise<void>) {
  const w = wallets().eth; await noPending('ethereum', w.address);
  const fees = await estimateEthereum(w, data), prepared = Date.now();
  review(title, `${description}\n\nEstimated Ethereum gas: ${fees.gasLimit}\nMaximum cost: ${formatEther(fees.cap)} ETH (actual cost may be lower)\nPaying wallet: ${w.address}\nNo ETH is sent to the bridge contract.`, async () => {
    if (Date.now() - prepared > 120_000) throw Error('Gas review expired. Estimate again.');
    await assertEthAccount(w); await noPending('ethereum', w.address); await recheck();
    // Re-simulate against current state; never silently raise the approved fee cap.
    const gas = await w.provider.estimateGas({ to: BRIDGE, from: w.address, data, value: 0n });
    if (gas > fees.gasLimit) throw Error('Required gas increased. Prepare a fresh estimate.');
    const tx = await w.signer.sendTransaction({ to: BRIDGE, data, value: 0n, gasLimit: fees.gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    record({ hash: tx.hash, chain: 'ethereum', account: w.address, label: title, time: Date.now(), status: 'pending' });
    notice(`Ethereum transaction submitted: ${tx.hash}. Refresh to check confirmation.`); await refresh();
  }, `Contract: ${BRIDGE}\nCalldata:\n${data}`);
}
on('valset', async () => { const w = wallets(); const update = await prepareValsetUpdate(w.eth); await ethReview('Update Ethereum validator set', update.data, `Update to validator set ${update.nonce}. This maintenance transaction does not transfer your NYM.`, async () => { if ((await prepareValsetUpdate(w.eth)).data !== update.data) throw Error('Validator update changed. Prepare again.'); }); });

async function reconcile() {
  for (const entry of history().filter(x => x.status === 'pending')) {
    try {
      if (entry.chain === 'ethereum' && eth) {
        const receipt = await eth.provider.getTransactionReceipt(entry.hash);
        if (receipt) record({ ...entry, status: receipt.status === 1 ? 'confirmed' : 'failed' });
      } else if (entry.chain !== 'ethereum') {
        const wallet = entry.chain === 'nyx' ? nyx : gravity;
        if (!wallet || wallet.address !== entry.account) continue;
        const tx = await wallet.client.getTx(entry.hash);
        if (tx) record({ ...entry, status: tx.code === 0 ? 'confirmed' : 'failed', detail: tx.rawLog, packet: extractPacket(tx.events) });
        else if (entry.timeoutHeight && entry.sequence && BigInt(await wallet.client.getHeight()) > BigInt(entry.timeoutHeight) + 5n) {
          const sequence = (await wallet.client.getSequence(entry.account)).sequence;
          if (BigInt(sequence) === BigInt(entry.sequence)) record({ ...entry, status: 'expired', detail: 'Transaction timeout passed with the signer sequence unchanged.' });
        }
        // Never infer that "not found" means failure: indexers can lag. Leave pending.
      }
    } catch { /* Keep unresolved transactions pending; do not invite a duplicate send. */ }
  }
  // Source-chain acknowledgement/timeout events distinguish delivery from a refund.
  for (const entry of history().filter(x => x.chain === 'nyx' && x.status === 'confirmed' && x.packet && !['Delivered to Gravity', 'Refunded on Nyx'].includes(x.ibcStatus || ''))) {
    if (!nyx || entry.account !== nyx.address) continue;
    try {
      const sequence = entry.packet!.sequence;
      if (!/^\d+$/.test(sequence)) continue;
      const acknowledgement = await nyx.client.searchTx(`acknowledge_packet.packet_sequence='${sequence}' AND acknowledge_packet.packet_src_channel='channel-0'`);
      const timeout = acknowledgement.length ? [] : await nyx.client.searchTx(`timeout_packet.packet_sequence='${sequence}' AND timeout_packet.packet_src_channel='channel-0'`);
      const ack = acknowledgement.filter(t => t.code === 0).flatMap(t => t.events).find(e => e.type === 'acknowledge_packet' && e.attributes.some(a => a.key === 'packet_sequence' && a.value === sequence) && e.attributes.some(a => a.key === 'packet_src_channel' && a.value === 'channel-0'));
      if (ack) {
        const value = ack.attributes.find(a => a.key === 'packet_ack')?.value;
        let status = 'Acknowledged; check Gravity balance';
        if (value) { const parsed = JSON.parse(value); status = parsed.error ? 'Refunded on Nyx' : parsed.result ? 'Delivered to Gravity' : status; }
        record({ ...entry, ibcStatus: status });
      } else if (timeout.some(t => t.code === 0)) record({ ...entry, ibcStatus: 'Refunded on Nyx' });
      else record({ ...entry, ibcStatus: BigInt(Date.now()) * 1_000_000n > BigInt(entry.packet!.timeout) ? 'IBC timeout passed; waiting for relayer refund' : 'IBC delivery pending' });
    } catch { /* An unavailable indexer is not proof of delivery or refund. */ }
  }
}
function renderHistory() {
  const box = $('history'); box.replaceChildren();
  const entries = history(); if (!entries.length) { box.textContent = 'No transactions yet.'; return; }
  for (const entry of entries) {
    const item = document.createElement('p'), link = document.createElement('a');
    link.textContent = `${entry.hash.slice(0, 12)}…`;
    link.href = entry.chain === 'ethereum' ? `https://etherscan.io/tx/${encodeURIComponent(entry.hash)}` : `https://www.mintscan.io/${entry.chain === 'nyx' ? 'nyx' : 'gravity-bridge'}/tx/${encodeURIComponent(entry.hash)}`;
    link.target = '_blank'; link.rel = 'noreferrer';
    const fee = entry.walletFee ? `\nWallet-approved fee: ${entry.walletFee.amount.map(c => ['unym', 'ugraviton', DENOM].includes(c.denom) ? `${formatNym(BigInt(c.amount))} ${c.denom === 'ugraviton' ? 'GRAV' : 'NYM'}` : `${c.amount} ${c.denom}`).join(' + ') || '0'} · gas limit ${entry.walletFee.gasLimit}` : '';
    item.append(`${entry.label}\n${entry.status} on ${entry.chain}${entry.ibcStatus ? '\n' + entry.ibcStatus : ''}${fee} · `, link); box.append(item);
  }
}
on('export', async () => { const blob = new Blob([JSON.stringify(history(), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'nym-bridge-activity.json'; a.click(); URL.revokeObjectURL(url); });
renderHistory();
