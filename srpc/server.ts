import { Duplex, Source } from 'it-stream-types'
import { pipe } from 'it-pipe'

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
  // uses handlePacketDuplex (expects 1 buf = 1 Packet)
  public get rpcStreamHandler(): RpcStreamHandler {
    return this.handlePacketStream.bind(this)
  }

  // startRpc starts a new server-side RPC.
  // the returned RPC handles incoming Packets.
  public startRpc(): ServerRPC {
    return new ServerRPC(this.lookupMethod)
  }

  // handleFragmentStream handles an incoming stream.
  // assumes that stream does not maintain packet framing.
  // uses length-prefixed packets for packet framing.
  public handleFragmentStream(stream: Stream): ServerRPC {
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
      stream,
    )
    return rpc
  }

  // handlePacketStream handles an incoming Uint8Array duplex.
  // the stream has one Uint8Array per packet w/o length prefix.
  public handlePacketStream(stream: Stream): ServerRPC {
    const rpc = this.startRpc()
    pipe(stream, decodePacketSource, rpc, encodePacketSource, stream)
    return rpc
  }

  // handlePacketDuplex handles an incoming Packet duplex.
  public handlePacketDuplex(stream: Duplex<Source<Packet>>): ServerRPC {
    const rpc = this.startRpc()
    pipe(stream, rpc, stream)
    return rpc
  }
}
