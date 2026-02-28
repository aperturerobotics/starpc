import { pipe } from 'it-pipe'

import { LookupMethod } from './mux.js'
import { ServerRPC } from './server-rpc.js'
import { decodePacketSource, encodePacketSource } from './packet.js'
import type { StreamHandler } from './conn.js'
import { PacketStream } from './stream.js'
import { RpcStreamHandler } from '../rpcstream/rpcstream.js'

// Server implements the SRPC server in TypeScript with a Mux.
export class Server implements StreamHandler {
  // lookupMethod looks up the incoming RPC methods.
  private lookupMethod: LookupMethod

  constructor(lookupMethod: LookupMethod) {
    this.lookupMethod = lookupMethod
  }

  // rpcStreamHandler implements the RpcStreamHandler interface.
  // uses handlePacketDuplex (expects 1 buf = 1 Packet)
  public get rpcStreamHandler(): RpcStreamHandler {
    return async (stream: PacketStream) => {
      const rpc = this.startRpc()
      return pipe(stream, decodePacketSource, rpc, encodePacketSource, stream)
        .catch((err: Error) => rpc.close(err))
        .then(() => rpc.close())
    }
  }

  // startRpc starts a new server-side RPC.
  // the returned RPC handles incoming Packets.
  public startRpc(): ServerRPC {
    return new ServerRPC(this.lookupMethod)
  }

  // handlePacketStream handles an incoming Uint8Array duplex.
  // the stream has one Uint8Array per packet w/o length prefix.
  public handlePacketStream(stream: PacketStream): ServerRPC {
    const rpc = this.startRpc()
    pipe(stream, decodePacketSource, rpc, encodePacketSource, stream)
      .catch((err: Error) => rpc.close(err))
      .then(() => rpc.close())
    return rpc
  }
}
