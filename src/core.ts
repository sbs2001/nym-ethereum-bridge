export const NYM = '0x525A8F6F3Ba4752868cde25164382BfbaE3990e1';
export const BRIDGE = '0xa4108aA1Ec4967F8b52220a4f7e94A8201F2D906';
export const DENOM = 'ibc/0C273962C274B2C05B22D9474BFE5B84D6A6FCAD198CB9B0ACD35EA521A36606';
export const SCALE = 1_000_000n;
export function parseNym(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value.trim())) throw Error('Enter a positive NYM amount with at most six decimals.');
  const [a, b = ''] = value.trim().split('.');
  const amount = BigInt(a) * SCALE + BigInt(b.padEnd(6, '0'));
  if (amount <= 0n) throw Error('Amount must be greater than zero.');
  return amount;
}
export function formatNym(amount: bigint): string {
  return `${amount / SCALE}.${(amount % SCALE).toString().padStart(6, '0')}`.replace(/\.?0+$/, '') || '0';
}
export function feeFor(amount: bigint, bps: bigint) { return amount * bps / 10_000n; }
export function budgetQuote(budget: bigint, bps: bigint) {
  if (budget <= 0n || bps < 0n || bps > 10_000n) throw Error('Invalid budget or fee rate.');
  // Largest integer amount for which amount + floor(amount * bps / 10000) <= budget.
  const receive = ((budget + 1n) * 10_000n - 1n) / (10_000n + bps);
  return { receive, chainFee: feeFor(receive, bps), total: receive + feeFor(receive, bps) };
}
export type Transfer = { id: string; sender: string; dest_address: string; erc20_token: { amount: string; contract: string }; erc20_fee: { amount: string; contract: string } };
export type Batch = { batch_nonce: string; batch_timeout: string; token_contract: string; transactions: Transfer[] };
export type Valset = { nonce: string; reward_amount: string; reward_token: string; members: { ethereum_address: string; power: string }[] };
export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function ownNymTransfer(t: Transfer, sender: string) { return t.sender === sender && sameAddress(t.erc20_token.contract, NYM); }
export async function api(chain: 'nyx' | 'gravity', path: string): Promise<any> {
  const r = await fetch(`/api/${chain}-rest${path}`, { signal: AbortSignal.timeout(28_000) });
  const j = await r.json();
  if (!r.ok || j.error || (j.code && j.message)) throw Error(`${chain}: ${j.message || j.error || r.status}`);
  return j;
}
