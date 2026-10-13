import { BinaryReader, BinaryWriter } from 'cosmjs-types/binary';
import { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import { Registry } from '@cosmjs/proto-signing';
import { AminoTypes, createDefaultAminoConverters, defaultRegistryTypes } from '@cosmjs/stargate';

// Field numbers taken from Gravity-Bridge/module/proto/gravity/v1/msgs.proto.
// Static codecs avoid runtime protobuf code generation and unsafe-eval.
function codec(name: string, fields: [string, 'string' | 'coin' | 'uint64'][]): any {
  return {
    typeUrl: `/gravity.v1.${name}`,
    fromPartial(value: any) { return Object.fromEntries(fields.map(([k, t]) => [k, value[k] ?? (t === 'coin' ? { denom: '', amount: '' } : t === 'uint64' ? 0n : '')])); },
    encode(value: any, writer = BinaryWriter.create()) {
      fields.forEach(([k, t], i) => {
        if (t === 'coin') Coin.encode(value[k], writer.uint32(((i + 1) << 3) | 2).fork()).ldelim();
        else if (t === 'uint64') { if (BigInt(value[k])) writer.uint32((i + 1) << 3).uint64(BigInt(value[k])); }
        else if (value[k]) writer.uint32(((i + 1) << 3) | 2).string(value[k]);
      });
      return writer;
    },
    decode(input: Uint8Array | BinaryReader, length?: number) {
      const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
      const end = length === undefined ? reader.len : reader.pos + length;
      const value = this.fromPartial({});
      while (reader.pos < end) {
        const tag = reader.uint32(), field = fields[(tag >>> 3) - 1];
        if (!field) { reader.skipType(tag & 7); continue; }
        const [key, type] = field;
        value[key] = type === 'coin' ? Coin.decode(reader, reader.uint32()) : type === 'uint64' ? reader.uint64() : reader.string();
      }
      return value;
    },
  };
}
export const SendToEth = codec('MsgSendToEth', [['sender', 'string'], ['ethDest', 'string'], ['amount', 'coin'], ['bridgeFee', 'coin'], ['chainFee', 'coin']]);
export const RequestBatch = codec('MsgRequestBatch', [['sender', 'string'], ['denom', 'string']]);
export const CancelSend = codec('MsgCancelSendToEth', [['transactionId', 'uint64'], ['sender', 'string']]);
export const registry = new Registry([...defaultRegistryTypes, [SendToEth.typeUrl, SendToEth], [RequestBatch.typeUrl, RequestBatch], [CancelSend.typeUrl, CancelSend]]);
export const aminoTypes = new AminoTypes({
  ...createDefaultAminoConverters(),
  [SendToEth.typeUrl]: { aminoType: 'gravity/MsgSendToEth', toAmino: (v: any) => ({ sender: v.sender, eth_dest: v.ethDest, amount: v.amount, bridge_fee: v.bridgeFee, chain_fee: v.chainFee }), fromAmino: (v: any) => ({ sender: v.sender, ethDest: v.eth_dest, amount: v.amount, bridgeFee: v.bridge_fee, chainFee: v.chain_fee }) },
  [RequestBatch.typeUrl]: { aminoType: 'gravity/MsgRequestBatch', toAmino: (v: any) => v, fromAmino: (v: any) => v },
  [CancelSend.typeUrl]: { aminoType: 'gravity/MsgCancelSendToEth', toAmino: (v: any) => ({ transaction_id: v.transactionId.toString(), sender: v.sender }), fromAmino: (v: any) => ({ transactionId: BigInt(v.transaction_id), sender: v.sender }) },
});
