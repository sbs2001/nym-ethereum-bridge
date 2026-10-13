import { Contract } from 'ethers';
import { api, BRIDGE, DENOM, NYM, sameAddress } from './core';
import { currentValset, EthWallet } from './ethereum';

export async function checkRoute(eth?: EthWallet) {
  const results = await Promise.allSettled([
    api('gravity', '/gravity/v1beta/params'),
    api('nyx', '/cosmos/base/tendermint/v1beta1/blocks/latest'),
    api('gravity', '/cosmos/base/tendermint/v1beta1/blocks/latest'),
    api('nyx', '/ibc/core/channel/v1/channels/channel-0/ports/transfer'),
    api('gravity', '/ibc/core/channel/v1/channels/channel-18/ports/transfer'),
    api('gravity', `/gravity/v1beta/cosmos_originated/erc20_to_denom?erc20=${NYM}`),
    api('gravity', `/ibc/apps/transfer/v1/denom_traces/${DENOM.slice(4)}`),
    api('nyx', '/ibc/core/client/v1/client_status/07-tendermint-1'),
    api('gravity', '/ibc/core/client/v1/client_status/07-tendermint-33'),
  ]);
  const failure = results.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const [p, n, g, nc, gc, mapping, trace, ns, gs] = results.map(r => (r as PromiseFulfilledResult<any>).value);
  for (const [data, id] of [[n, 'nyx'], [g, 'gravity-bridge-3']] as const) {
    const h = data.block?.header || data.sdk_block?.header;
    if (h?.chain_id !== id) throw Error(`Unexpected chain identity from ${id}.`);
    const age = Date.now() - Date.parse(h.time);
    if (!Number.isFinite(age) || age > 180_000 || age < -60_000) throw Error(`${id} RPC is stale, or your computer clock is incorrect.`);
  }
  if (nc.channel?.state !== 'STATE_OPEN' || nc.channel?.counterparty?.channel_id !== 'channel-18' || gc.channel?.state !== 'STATE_OPEN' || gc.channel?.counterparty?.channel_id !== 'channel-0') throw Error('Nyx–Gravity IBC channel is not open with the expected counterpart.');
  if (ns.status !== 'Active' || gs.status !== 'Active') throw Error('An IBC light client is inactive. Wait for the channel operators to restore it.');
  if (!p.params.bridge_active || !sameAddress(p.params.bridge_ethereum_address, BRIDGE) || p.params.bridge_chain_id !== '1') throw Error('Gravity bridge is paused or its Ethereum configuration differs.');
  if (!mapping.cosmos_originated || mapping.denom !== DENOM || trace.denom_trace?.base_denom !== 'unym' || trace.denom_trace?.path !== 'transfer/channel-18') throw Error('Canonical NYM denomination mapping differs.');
  const bps = BigInt(p.params.min_chain_fee_basis_points);
  if (bps < 0n || bps > 10_000n) throw Error('Invalid chain fee parameter.');
  let ethInfo = 'Connect Ethereum to complete relay checks';
  if (eth) {
    if ((await eth.provider.getNetwork()).chainId !== 1n) throw Error('Ethereum wallet must be on mainnet.');
    const token = new Contract(NYM, ['function decimals() view returns(uint8)'], eth.provider);
    const [decimals, code, observed, head, validators] = await Promise.all([
      token.decimals(), eth.provider.getCode(BRIDGE), api('gravity', '/gravity/v1beta/query_last_observed_eth_block'), eth.provider.getBlockNumber(), currentValset(eth),
    ]);
    if (decimals !== 6n || code === '0x') throw Error('NYM decimals or bridge deployment check failed.');
    const lag = BigInt(head) - BigInt(observed.block);
    if (lag < -5n || lag > 600n || observed.block === '0') throw Error(`Gravity's Ethereum oracle is ${lag} blocks behind. Wait before starting a new transfer.`);
    ethInfo = `Ethereum mainnet · validator set ${validators.nonce} · oracle lag ${lag} blocks`;
  }
  return { bps, ethInfo, blacklist: p.params.ethereum_blacklist as string[], checkedAt: Date.now() };
}
