import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthInfo, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { registry, RequestBatch } from '../src/messages';
import { DENOM } from '../src/core';
import { history, sendCosmos } from '../src/cosmos';

test('broadcasts the wallet-selected gas and fee, but rejects modified transfer messages', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { keplr: { getKey: async () => ({ bech32Address: 'gravity1test' }) } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) } });
  try {
    let modifiedMessage = false;
    let broadcasts = 0;
    let signedBytes: Uint8Array;
    const selectedFee = { gasLimit: 275000n, amount: [{ denom: DENOM, amount: '4321' }], payer: '', granter: '' };
    const wallet: any = { address: 'gravity1test', client: {
      getHeight: async () => 100,
      sign: async (_sender: string, messages: any[], _fee: any, memo: string, _data: any, timeoutHeight: bigint) => {
        const tx = TxRaw.fromPartial({
          bodyBytes: registry.encodeTxBody({ messages: modifiedMessage ? [{ ...messages[0], value: { ...messages[0].value, denom: 'other-token' } }] : messages, memo, timeoutHeight }),
          authInfoBytes: AuthInfo.encode(AuthInfo.fromPartial({ signerInfos: [{ sequence: 7n }], fee: selectedFee })).finish(),
          signatures: [new Uint8Array(64)], // Mock only; no real key, signature or RPC.
        });
        signedBytes = TxRaw.encode(tx).finish(); return tx;
      },
      broadcastTx: async (bytes: Uint8Array) => {
        broadcasts++;
        assert.deepEqual(bytes, signedBytes);
        assert.deepEqual(AuthInfo.decode(TxRaw.decode(bytes).authInfoBytes).fee, selectedFee);
        return { code: 0, events: [], rawLog: '', transactionHash: 'mock' };
      },
    } };
    const msg = { typeUrl: RequestBatch.typeUrl, value: { sender: wallet.address, denom: DENOM } };
    const suggested = { gas: '200000', amount: [{ denom: 'ugraviton', amount: '0' }] };
    await sendCosmos('gravity', wallet, [msg], suggested, 'Request batch');
    assert.equal(broadcasts, 1);
    assert.deepEqual(history()[0].walletFee, { gasLimit: '275000', amount: selectedFee.amount });
    modifiedMessage = true;
    await assert.rejects(sendCosmos('gravity', wallet, [msg], suggested, 'Request batch'), /Wallet changed the reviewed transaction/);
    assert.equal(broadcasts, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete (globalThis as any).window;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete (globalThis as any).localStorage;
  }
});
