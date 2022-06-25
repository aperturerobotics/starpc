import { Stream } from '@libp2p/interface-connection'
import { Duplex } from 'it-stream-types'
import { pipe } from 'it-pipe'

import { Mux } from './mux.js'
import { ServerRPC } from './server-rpc.js'
import { Packet } from './rpcproto.pb.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
  decodePacketSource,
  encodePacketSource,
} from './packet.js'
import { StreamHandler } from './conn.js'

// Server implements the SRPC server in TypeScript with a Mux.
export class Server implements StreamHandler {
  // mux is the mux used to handle requests.
  private mux: Mux

  constructor(mux: Mux) {
    this.mux = mux
  }

  // startRpc starts a new server-side RPC.
  // the returned RPC handles incoming Packets.
  public startRpc(): ServerRPC {
    return new ServerRPC(this.mux)
  }

  // handleStream handles an incoming Uint8Array message duplex.
  public handleStream(stream: Stream): ServerRPC {
    return this.handleDuplex(stream)
  }

  // handleDuplex handles an incoming message duplex.
  public handleDuplex(stream: Duplex<Uint8Array>): ServerRPC {
    const rpc = this.startRpc()
    pipe(
      stream,
      parseLengthPrefixTransform(),
      decodePacketSource,
      rpc,
      encodePacketSource,
      prependLengthPrefixTransform(),
      stream
    )
    return rpc
  }

  // handlePacketStream handles an incoming Packet duplex.
  public handlePacketStream(stream: Duplex<Packet>): ServerRPC {
    const rpc = this.startRpc()
    pipe(stream, rpc, stream)
    return rpc
  }
}
