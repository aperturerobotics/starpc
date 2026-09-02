import { pipe } from 'it-pipe'

import { LookupMethod } from './mux.js'
import { ServerRPC } from './server-rpc.js'
import { decodePacketSource, encodePacketSource } from './packet.js'
import type { StreamHandler } from './conn.js'
import { HandleStreamFunc, PacketStream } from './stream.js'

// Server implements the SRPC server in TypeScript with a Mux.
export class Server implements StreamHandler {
  // lookupMethod looks up the incoming RPC methods.
  private lookupMethod: LookupMethod

  constructor(lookupMethod: LookupMethod) {
    this.lookupMethod = lookupMethod
  }

  // rpcStreamHandler implements the RpcStreamHandler interface.
  // uses handlePacketDuplex (expects 1 buf = 1 Packet)
  public get rpcStreamHandler(): HandleStreamFunc {
    return async (stream: PacketStream) => {
      const rpc = this.startRpc()
      return runPacketStream(stream, rpc)
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
    void runPacketStream(stream, rpc).catch(() => undefined)
    return rpc
  }
}

async function runPacketStream(
  stream: PacketStream,
  rpc: ServerRPC,
): Promise<void> {
  try {
    await pipe(stream, decodePacketSource, rpc, encodePacketSource, stream)
    if (rpc.isClosed instanceof Error) {
      stream.abort(rpc.isClosed)
      throw rpc.isClosed
    }
    await stream.close()
    await rpc.close()
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    stream.abort(error)
    await rpc.close(error)
    throw error
  }
}
