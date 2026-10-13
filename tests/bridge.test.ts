import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getBytes, Interface, ZeroAddress } from 'ethers';
import protobuf from 'protobufjs';
import { budgetQuote, DENOM, feeFor, formatNym, NYM, ownNymTransfer, parseNym, type Batch, type Valset } from '../src/core';
import { SendToEth, RequestBatch, CancelSend, registry, aminoTypes } from '../src/messages';
import { batchConfirmations, batchHash, checkpoint, contractInterface, orderSignatures, valsetTuple } from '../src/ethereum';
import releasedABI from '../src/gravity-abi.json';

test('750,000 NYM budget is exact and cannot overspend', () => {
  const q = budgetQuote(parseNym('750000'), 20n);
  assert.equal(q.receive, 748502994012n);
  assert.equal(q.chainFee, 1497005988n);
  assert.equal(q.total, 750000000000n);
  assert.equal(formatNym(q.receive), '748502.994012');
});
test('budget calculation maximizes the output across rounding boundaries', () => {
  for (const rate of [0n, 1n, 20n, 300n, 9999n, 10000n]) {
    for (let budget = 1n; budget < 1500n; budget++) {
      const q = budgetQuote(budget, rate);
      assert(q.total <= budget);
      assert(q.receive + 1n + feeFor(q.receive + 1n, rate) > budget);
    }
  }
});
test('amounts beyond Number precision survive exact parsing and formatting', () => {
  const s = '99999999999999999.123456'; assert.equal(formatNym(parseNym(s)), s);
  for (const bad of ['1e6', '-1', 'NaN', '', '0', '1.0000001', '1,000', '.5']) assert.throws(() => parseNym(bad));
  assert.equal(formatNym(0n), '0'); assert.equal(formatNym(10000000n), '10');
});

const schema = protobuf.parse(`syntax="proto3";
message Coin { string denom=1; string amount=2; }
message MsgSendToEth { string sender=1; string eth_dest=2; Coin amount=3; Coin bridge_fee=4; Coin chain_fee=5; }
message MsgRequestBatch { string sender=1; string denom=2; }
message MsgCancelSendToEth { uint64 transaction_id=1; string sender=2; }`).root;
test('Gravity messages match independently generated protobuf bytes', () => {
  const samples: [any, any][] = [
    [SendToEth, { sender: 'gravity1test', ethDest: NYM, amount: { denom: DENOM, amount: '748502994012' }, bridgeFee: { denom: DENOM, amount: '0' }, chainFee: { denom: DENOM, amount: '1497005988' } }],
    [RequestBatch, { sender: 'gravity1test', denom: DENOM }],
    [CancelSend, { transactionId: 9007199254740993n, sender: 'gravity1test' }],
  ];
  for (const [codec, value] of samples) {
    const type = schema.lookupType(codec.typeUrl.split('.').at(-1)!);
    const reference = type.encode(type.fromObject(JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)))).finish();
    const actual = registry.encode({ typeUrl: codec.typeUrl, value });
    assert.deepEqual([...actual], [...reference]);
    assert.deepEqual(codec.decode(actual), value);
    assert.deepEqual(aminoTypes.fromAmino(aminoTypes.toAmino({ typeUrl: codec.typeUrl, value })).value, value);
  }
});

// Public deterministic test keys, never connected to any network or funded.
const keys = [1, 2, 3].map(n => new Wallet('0x' + n.toString(16).padStart(64, '0')));
const valset: Valset = { nonce: '23', reward_amount: '0', reward_token: ZeroAddress, members: keys.map((w, i) => ({ ethereum_address: w.address, power: ['2000000000', '1500000000', '794967296'][i] })) };
const gravityId = '0x' + Buffer.from('gravity-bridge-mainnet').toString('hex').padEnd(64, '0');
const batch: Batch = { batch_nonce: '42', batch_timeout: '26000000', token_contract: NYM, transactions: [{ id: '123', sender: 'gravity1mine', dest_address: keys[2].address, erc20_token: { amount: '1000000', contract: NYM }, erc20_fee: { amount: '0', contract: NYM } }] };
test('batch signatures are verified, ordered by current validator set, and threshold enforced', async () => {
  const digest = batchHash(batch, gravityId);
  const confirms = await Promise.all(keys.slice(0, 2).map(async k => ({ eth_address: k.address, signature: (await k.signMessage(getBytes(digest))).slice(2) })));
  const sigs = orderSignatures(valset, confirms.reverse(), digest);
  assert.equal(sigs.length, 3); assert.equal(sigs[2][0], 0);
  assert.throws(() => orderSignatures(valset, confirms.slice(0, 1), digest), /not ready/);
  assert.throws(() => orderSignatures(valset, confirms, batchHash({ ...batch, batch_timeout: '26000001' }, gravityId)), /not ready/);
  assert.throws(() => orderSignatures(valset, [{ ...confirms[0], signature: 'broken' }], digest), /not ready/);
  const data = contractInterface.encodeFunctionData('submitBatch', [valsetTuple(valset), sigs, ['1000000'], [keys[2].address], ['0'], batch.batch_nonce, NYM, batch.batch_timeout]);
  const parsed = contractInterface.parseTransaction({ data })!;
  assert.equal(parsed.name, 'submitBatch'); assert.equal(parsed.args[6], NYM); assert.equal(parsed.args[3][0], keys[2].address);
});
test('validator checkpoint changes when member order, power, or nonce changes', () => {
  const original = checkpoint(valset, gravityId);
  assert.notEqual(original, checkpoint({ ...valset, nonce: '24' }, gravityId));
  assert.notEqual(original, checkpoint({ ...valset, members: [...valset.members].reverse() }, gravityId));
});
test('pending transfers must match both the connected account and canonical token', () => {
  const transfer = batch.transactions[0]; assert(ownNymTransfer(transfer, 'gravity1mine'));
  assert(!ownNymTransfer(transfer, 'gravity1other'));
  assert(!ownNymTransfer({ ...transfer, erc20_token: { ...transfer.erc20_token, contract: ZeroAddress } }, 'gravity1mine'));
});
test('batch confirmation REST schema uses eth_signer, unlike validator confirmations', () => {
  const confirmations = [{ nonce: '42', token_contract: NYM, eth_signer: keys[0].address, signature: 'abc' }, { nonce: '41', token_contract: NYM, eth_signer: keys[1].address, signature: 'wrong-nonce' }];
  assert.deepEqual(batchConfirmations(confirmations, batch), [{ eth_address: keys[0].address, signature: 'abc' }]);
});
test('relay function selectors match the official v1.13.4 release ABI', () => {
  const release = new Interface(releasedABI);
  for (const name of ['submitBatch', 'updateValset', 'state_lastValsetNonce', 'state_lastValsetCheckpoint', 'state_gravityId', 'state_lastBatchNonces']) {
    assert.equal(contractInterface.getFunction(name)!.selector, release.getFunction(name)!.selector);
  }
});
