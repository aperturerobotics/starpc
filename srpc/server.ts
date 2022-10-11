import { Duplex } from 'it-stream-types'
import { pipe } from 'it-pipe'
import { Uint8ArrayList } from 'uint8arraylist'

import { LookupMethod } from './mux.js'
import { ServerRPC } from './server-rpc.js'
import { Packet } from './rpcproto.pb.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
  decodePacketSource,
  encodePacketSource,
} from './packet.js'
import { StreamHandler } from './conn.js'
import { Stream } from './stream.js'
import { RpcStreamHandler } from '../rpcstream/rpcstream.js'
import { combineUint8ArrayListTransform } from './array-list.js'

// Server implements the SRPC server in TypeScript with a Mux.
export class Server implements StreamHandler {
  // lookupMethod looks up the incoming RPC methods.
  private lookupMethod: LookupMethod

  constructor(lookupMethod: LookupMethod) {
    this.lookupMethod = lookupMethod
  }

  // rpcStreamHandler implements the RpcStreamHandler interface.
  public get rpcStreamHandler(): RpcStreamHandler {
    return this.handleStream.bind(this)
  }

  // startRpc starts a new server-side RPC.
  // the returned RPC handles incoming Packets.
  public startRpc(): ServerRPC {
    return new ServerRPC(this.lookupMethod)
  }

  // handleStream handles an incoming Uint8Array message duplex.
  public handleStream(stream: Stream): ServerRPC {
    return this.handleDuplex(stream)
  }

  // handleDuplex handles an incoming message duplex.
  public handleDuplex(stream: Duplex<Uint8Array, Uint8Array>): ServerRPC {
    const rpc = this.startRpc()
    pipe(
      stream,
      parseLengthPrefixTransform(),
      combineUint8ArrayListTransform(),
      decodePacketSource,
      rpc,
      encodePacketSource,
      prependLengthPrefixTransform(),
      combineUint8ArrayListTransform(),
      stream
    )
    return rpc
  }

  // handlePacketDuplex handles an incoming Uint8Array duplex.
  // skips the packet length prefix transform.
  public handlePacketDuplex(stream: Duplex<Uint8Array>): ServerRPC {
    const rpc = this.startRpc()
    pipe(stream, decodePacketSource, rpc, encodePacketSource, stream)
    return rpc
  }

  // handlePacketStream handles an incoming Packet duplex.
  public handlePacketStream(stream: Duplex<Packet>): ServerRPC {
    const rpc = this.startRpc()
    pipe(stream, rpc, stream)
    return rpc
  }
}
