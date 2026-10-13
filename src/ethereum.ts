import { AbiCoder, BrowserProvider, Contract, Interface, Signature, ZeroAddress, ZeroHash, encodeBytes32String, getBytes, keccak256, verifyMessage } from 'ethers';
import { api, Batch, BRIDGE, NYM, sameAddress, Valset } from './core';

// Gravity v1.13.4 release ABI, restricted to the operations this application uses.
const V = '(address[] validators,uint256[] powers,uint256 valsetNonce,uint256 rewardAmount,address rewardToken)';
const S = '(uint8 v,bytes32 r,bytes32 s)[]';
export const abi = [
  'function state_lastValsetNonce() view returns (uint256)',
  'function state_lastValsetCheckpoint() view returns (bytes32)',
  'function state_gravityId() view returns (bytes32)',
  'function state_lastBatchNonces(address) view returns (uint256)',
  `function submitBatch(${V} currentValset,${S} sigs,uint256[] amounts,address[] destinations,uint256[] fees,uint256 batchNonce,address tokenContract,uint256 batchTimeout)`,
  `function updateValset(${V} newValset,${V} currentValset,${S} sigs)`,
  'event ValsetUpdatedEvent(uint256 indexed newValsetNonce,uint256 eventNonce,uint256 rewardAmount,address rewardToken,address[] validators,uint256[] powers)',
  'event TransactionBatchExecutedEvent(uint256 indexed batchNonce,address indexed token,uint256 eventNonce)',
];
export const contractInterface = new Interface(abi);
const coder = AbiCoder.defaultAbiCoder();
export const valsetTuple = (v: Valset) => [v.members.map(m => m.ethereum_address), v.members.map(m => m.power), v.nonce, v.reward_amount, v.reward_token || ZeroAddress];
export function checkpoint(v: Valset, gravityId: string) {
  return keccak256(coder.encode(['bytes32', 'bytes32', 'uint256', 'address[]', 'uint256[]', 'uint256', 'address'], [gravityId, encodeBytes32String('checkpoint'), v.nonce, v.members.map(m => m.ethereum_address), v.members.map(m => m.power), v.reward_amount, v.reward_token || ZeroAddress]));
}
export function batchHash(batch: Batch, gravityId: string) {
  return keccak256(coder.encode(['bytes32', 'bytes32', 'uint256[]', 'address[]', 'uint256[]', 'uint256', 'address', 'uint256'], [gravityId, encodeBytes32String('transactionBatch'), batch.transactions.map(t => t.erc20_token.amount), batch.transactions.map(t => t.dest_address), batch.transactions.map(t => t.erc20_fee.amount), batch.batch_nonce, batch.token_contract, batch.batch_timeout]));
}
export function orderSignatures(v: Valset, confirms: { eth_address: string; signature: string }[], digest: string) {
  let power = 0n;
  const result = v.members.map(member => {
    const c = confirms.find(c => typeof c.eth_address === 'string' && sameAddress(c.eth_address, member.ethereum_address));
    if (c) {
      try {
        const sig = Signature.from(c.signature.startsWith('0x') ? c.signature : '0x' + c.signature);
        if (sameAddress(verifyMessage(getBytes(digest), sig), member.ethereum_address)) {
          power += BigInt(member.power); return [sig.v, sig.r, sig.s];
        }
      } catch { /* A malformed/foreign signature contributes no power. */ }
    }
    return [0, ZeroHash, ZeroHash];
  });
  if (power <= 2863311530n) throw Error(`Validator signatures are not ready: ${Number(power * 10000n / 4294967296n) / 100}% voting power. Refresh later or prepare a validator update.`);
  return result;
}
export function batchConfirmations(confirms: any[], batch: Batch) {
  return confirms.filter(c => String(c.nonce) === batch.batch_nonce && typeof c.token_contract === 'string' && sameAddress(c.token_contract, NYM) && typeof c.eth_signer === 'string')
    .map(c => ({ eth_address: c.eth_signer, signature: c.signature }));
}
export async function connectEthereum() {
  const injected = window.ethereum?.providers?.find((p: any) => p.isMetaMask) || window.ethereum;
  if (!injected) throw Error('Install MetaMask or another Ethereum browser wallet to pay for the relay.');
  await injected.request({ method: 'eth_requestAccounts' });
  if (await injected.request({ method: 'eth_chainId' }) !== '0x1') await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  const provider = new BrowserProvider(injected, 1, { cacheTimeout: -1 });
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress(), injected };
}
export type EthWallet = Awaited<ReturnType<typeof connectEthereum>>;
export async function assertEthAccount(w: EthWallet) {
  if (await w.injected.request({ method: 'eth_chainId' }) !== '0x1') throw Error('Switch the Ethereum wallet to Ethereum mainnet.');
  const addresses = await w.injected.request({ method: 'eth_accounts' });
  if (!addresses[0] || !sameAddress(addresses[0], w.address)) throw Error('Ethereum account changed. Reconnect and prepare again.');
}
export async function currentValset(w: EthWallet) {
  const bridge = new Contract(BRIDGE, abi, w.provider);
  const [nonce, expected, gravityId] = await Promise.all([bridge.state_lastValsetNonce(), bridge.state_lastValsetCheckpoint(), bridge.state_gravityId()]);
  let v: Valset | undefined;
  try { v = (await api('gravity', `/gravity/v1beta/valset?nonce=${nonce}`)).valset; } catch { /* Old valsets may have been pruned. */ }
  if (!v || checkpoint(v, gravityId) !== expected) {
    // Exact indexed nonce: the event is authenticated by its Ethereum checkpoint below.
    const logs = await w.provider.getLogs({ address: BRIDGE, topics: contractInterface.encodeFilterTopics('ValsetUpdatedEvent', [nonce]), fromBlock: 0, toBlock: 'latest' });
    if (!logs.length) throw Error('The Ethereum RPC could not retrieve the current validator set. Use a wallet RPC that supports historical event queries.');
    const args = contractInterface.parseLog(logs[logs.length - 1])!.args;
    v = { nonce: args[0].toString(), reward_amount: args[2].toString(), reward_token: args[3], members: args[4].map((address: string, i: number) => ({ ethereum_address: address, power: args[5][i].toString() })) };
  }
  if (checkpoint(v, gravityId) !== expected || v.nonce !== nonce.toString()) throw Error('Validator set does not match the Ethereum checkpoint.');
  return { valset: v, gravityId, nonce: nonce.toString() };
}
export async function prepareBatch(w: EthWallet, batch: Batch) {
  await assertEthAccount(w);
  if (!sameAddress(batch.token_contract, NYM)) throw Error('Only the canonical NYM token can be relayed.');
  if (!batch.transactions.length || batch.transactions.some(t => !sameAddress(t.erc20_token.contract, NYM) || !sameAddress(t.erc20_fee.contract, NYM))) throw Error('Invalid NYM batch.');
  const bridge = new Contract(BRIDGE, abi, w.provider);
  if (BigInt(batch.batch_nonce) <= await bridge.state_lastBatchNonces(NYM)) throw Error('This batch has already been relayed. Refresh.');
  if (BigInt(batch.batch_timeout) <= BigInt(await w.provider.getBlockNumber()) + 20n) throw Error('Batch expired or is too close to timeout. Wait for it to return to the queue.');
  const { valset, gravityId } = await currentValset(w);
  const { confirms } = await api('gravity', `/gravity/v1beta/batch/confirms?nonce=${batch.batch_nonce}&contract_address=${NYM}`);
  const sigs = orderSignatures(valset, batchConfirmations(confirms || [], batch), batchHash(batch, gravityId));
  return contractInterface.encodeFunctionData('submitBatch', [valsetTuple(valset), sigs, batch.transactions.map(t => t.erc20_token.amount), batch.transactions.map(t => t.dest_address), batch.transactions.map(t => t.erc20_fee.amount), batch.batch_nonce, NYM, batch.batch_timeout]);
}
export async function prepareValsetUpdate(w: EthWallet) {
  const { valset, gravityId } = await currentValset(w);
  const { valsets } = await api('gravity', '/gravity/v1beta/valset/requests');
  const candidates: Valset[] = (valsets || []).filter((v: Valset) => BigInt(v.nonce) > BigInt(valset.nonce));
  candidates.sort((a, b) => BigInt(a.nonce) > BigInt(b.nonce) ? -1 : 1);
  for (const next of candidates) {
    try {
      const { confirms } = await api('gravity', `/gravity/v1beta/confirms/${next.nonce}`);
      const sigs = orderSignatures(valset, confirms || [], checkpoint(next, gravityId));
      return { data: contractInterface.encodeFunctionData('updateValset', [valsetTuple(next), valsetTuple(valset), sigs]), nonce: next.nonce };
    } catch { /* Try an earlier update with enough overlapping signers. */ }
  }
  throw Error('No signed validator update can currently be submitted against the Ethereum validator set. No funds were sent.');
}
export async function estimateEthereum(w: EthWallet, data: string) {
  await assertEthAccount(w);
  const tx = { to: BRIDGE, from: w.address, data, value: 0n };
  const [gas, prices] = await Promise.all([w.provider.estimateGas(tx), w.provider.getFeeData()]);
  if (prices.maxFeePerGas === null || prices.maxPriorityFeePerGas === null) throw Error('Ethereum RPC did not return EIP-1559 fee data.');
  const gasLimit = gas * 120n / 100n;
  const cap = gasLimit * prices.maxFeePerGas;
  if (await w.provider.getBalance(w.address) < cap) throw Error('The Ethereum wallet needs more ETH to cover the displayed maximum gas cost.');
  return { gasLimit, maxFeePerGas: prices.maxFeePerGas, maxPriorityFeePerGas: prices.maxPriorityFeePerGas, cap };
}
