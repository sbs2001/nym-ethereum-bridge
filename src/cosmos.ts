import { SigningStargateClient, calculateFee, GasPrice, BroadcastTxError } from '@cosmjs/stargate';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { TxRaw, AuthInfo, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { registry, aminoTypes } from './messages';
import { api, DENOM } from './core';

declare global { interface Window { keplr?: any; ethereum?: any; } }
export type Chain = 'nyx' | 'gravity';
export const chainId = (c: Chain) => c === 'nyx' ? 'nyx' : 'gravity-bridge-3';
export type CosmosWallet = { address: string; client: SigningStargateClient };
export async function connectCosmos(chain: Chain): Promise<CosmosWallet> {
  if (!window.keplr) throw Error('Install Keplr or open this page in a browser where Keplr is enabled.');
  const config = await (await fetch('/api/config')).json();
  const nyx = chain === 'nyx';
  const prefix = nyx ? 'n' : 'gravity';
  const coin = { coinDenom: nyx ? 'NYM' : 'GRAV', coinMinimalDenom: nyx ? 'unym' : 'ugraviton', coinDecimals: 6 };
  await window.keplr.experimentalSuggestChain({
    chainId: chainId(chain), chainName: nyx ? 'Nyx' : 'Gravity Bridge', rpc: config[`${chain}-rpc`], rest: config[`${chain}-rest`],
    bip44: { coinType: 118 },
    bech32Config: { bech32PrefixAccAddr: prefix, bech32PrefixAccPub: prefix + 'pub', bech32PrefixValAddr: prefix + 'valoper', bech32PrefixValPub: prefix + 'valoperpub', bech32PrefixConsAddr: prefix + 'valcons', bech32PrefixConsPub: prefix + 'valconspub' },
    currencies: nyx ? [coin] : [coin, { coinDenom: 'NYM', coinMinimalDenom: DENOM, coinDecimals: 6 }],
    feeCurrencies: [{ ...coin, gasPriceStep: nyx ? { low: 0.025, average: 0.025, high: 0.04 } : { low: 0, average: 0, high: 0.035 } }],
    stakeCurrency: nyx ? { coinDenom: 'NYX', coinMinimalDenom: 'unyx', coinDecimals: 6 } : coin,
    features: ['ibc-transfer', 'ibc-go'],
  });
  await window.keplr.enable(chainId(chain));
  const signer = await window.keplr.getOfflineSignerAuto(chainId(chain));
  const [account] = await signer.getAccounts();
  if (!account) throw Error('Keplr did not return an account.');
  const client = await SigningStargateClient.connectWithSigner(`${location.origin}/api/${chain}-rpc`, signer, { registry, aminoTypes, broadcastTimeoutMs: 45_000 });
  if (await client.getChainId() !== chainId(chain)) throw Error('RPC chain identity mismatch.');
  return { address: account.address, client };
}
export async function assertCosmosAccount(chain: Chain, wallet: CosmosWallet) {
  const key = await window.keplr.getKey(chainId(chain));
  if (key.bech32Address !== wallet.address) throw Error('Keplr account changed. Reconnect and prepare again.');
}
export async function simulate(wallet: CosmosWallet, msgs: EncodeObject[], gasPrice: string) {
  const estimate = await wallet.client.simulate(wallet.address, msgs, 'NYM direct bridge');
  const gas = Math.ceil(estimate * 1.4);
  return calculateFee(gas, GasPrice.fromString(gasPrice));
}
export type HistoryEntry = { hash: string; chain: Chain | 'ethereum'; account: string; label: string; time: number; status: 'pending' | 'confirmed' | 'failed' | 'expired'; timeoutHeight?: string; sequence?: string; detail?: string; walletFee?: { gasLimit: string; amount: { denom: string; amount: string }[] }; packet?: { sequence: string; amount: string; receiver: string; timeout: string }; ibcStatus?: string };
export const historyKey = 'nym-direct-bridge-history-v1';
export function history(): HistoryEntry[] {
  try { const a = JSON.parse(localStorage.getItem(historyKey) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
export function record(entry: HistoryEntry) {
  const old = history().filter(x => x.hash !== entry.hash);
  // Persist before broadcast; a storage failure aborts the send.
  localStorage.setItem(historyKey, JSON.stringify([entry, ...old]));
}
export async function sendCosmos(chain: Chain, wallet: CosmosWallet, msgs: EncodeObject[], fee: any, label: string) {
  await assertCosmosAccount(chain, wallet);
  const height = BigInt(await wallet.client.getHeight()) + 100n;
  const tx = await wallet.client.sign(wallet.address, msgs, fee, 'NYM direct bridge', undefined, height);
  const signedBody = TxBody.decode(tx.bodyBytes), signedFee = AuthInfo.decode(tx.authInfoBytes).fee;
  if (signedBody.messages.length !== msgs.length || signedBody.messages.some((msg, i) => msg.typeUrl !== msgs[i].typeUrl || toHex(msg.value) !== toHex(registry.encode(msgs[i]))) || signedBody.timeoutHeight !== height) throw Error('Wallet changed the reviewed transaction. Nothing was broadcast.');
  // The app supplies an estimate; Keplr's approval screen sets the final fee.
  // Broadcast the wallet-signed bytes unchanged, including its gas limit and fee coins.
  if (!signedFee || signedFee.gasLimit <= 0n) throw Error('Wallet returned no valid gas limit. Nothing was broadcast.');
  const bytes = TxRaw.encode(tx).finish();
  const entry: HistoryEntry = { hash: toHex(sha256(bytes)).toUpperCase(), chain, account: wallet.address, label, time: Date.now(), status: 'pending', timeoutHeight: height.toString(), sequence: AuthInfo.decode(tx.authInfoBytes).signerInfos[0].sequence.toString(), walletFee: { gasLimit: signedFee.gasLimit.toString(), amount: signedFee.amount } };
  record(entry);
  try {
    const result = await wallet.client.broadcastTx(bytes);
    record({ ...entry, status: result.code === 0 ? 'confirmed' : 'failed', detail: result.rawLog, packet: extractPacket(result.events) });
    if (result.code) throw Error(`Transaction failed: ${result.rawLog}`);
    return result;
  } catch (e: any) {
    // Explicit CheckTx rejection is different from an ambiguous network timeout.
    if (e instanceof BroadcastTxError) record({ ...entry, status: 'failed', detail: e.message });
    throw Error(`${e.message}. Transaction ${entry.hash} is recorded; refresh its status before retrying.`);
  }
}
export function extractPacket(events: readonly any[]) {
  const event = events.find(e => e.type === 'send_packet');
  if (!event) return undefined;
  const attrs = Object.fromEntries(event.attributes.map((a: any) => [a.key, a.value]));
  if (attrs.packet_src_channel !== 'channel-0' || attrs.packet_dst_channel !== 'channel-18') return undefined;
  try { const data = JSON.parse(attrs.packet_data); return { sequence: String(attrs.packet_sequence), amount: String(data.amount), receiver: String(data.receiver), timeout: String(attrs.packet_timeout_timestamp) }; } catch { return undefined; }
}
export async function balance(chain: Chain, address: string, denom: string): Promise<bigint> {
  const j = await api(chain, `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`);
  return BigInt(j.balance?.amount || '0');
}
