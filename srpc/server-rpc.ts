import type { Sink, Source } from 'it-stream-types'

import type { CallData, CallStart } from './rpcproto.pb.js'
import { CommonRPC } from './common-rpc.js'
import { InvokeFn } from './handler.js'
import { LookupMethod } from './mux.js'

// ServerRPC is an ongoing RPC from the server side.
export class ServerRPC extends CommonRPC {
  // lookupMethod looks up the incoming RPC methods.
  private lookupMethod: LookupMethod

  constructor(lookupMethod: LookupMethod) {
    super()
    this.lookupMethod = lookupMethod
  }

  // handleCallStart handles a CallStart cket.
  public override async handleCallStart(packet: Partial<CallStart>) {
    if (this.service || this.method) {
      throw new Error('call start must be sent only once')
    }
    this.service = packet.rpcService
    this.method = packet.rpcMethod
    if (!this.service || !this.method) {
      throw new Error('rpcService and rpcMethod cannot be empty')
    }
    if (!this.lookupMethod) {
      throw new Error('LookupMethod is not defined')
    }
    const methodDef = await this.lookupMethod(this.service, this.method)
    if (!methodDef) {
      throw new Error(`not found: ${this.service}/${this.method}`)
    }
    this.pushRpcData(packet.data, packet.dataIsZero)
    this.invokeRPC(methodDef)
  }

  // handleCallData handles a CallData packet.
  public override async handleCallData(packet: Partial<CallData>) {
    if (!this.service || !this.method) {
      throw new Error('call start must be sent before call data')
    }
    return super.handleCallData(packet)
  }

  // invokeRPC starts invoking the RPC handler.
  private async invokeRPC(invokeFn: InvokeFn) {
    const dataSink = this._createDataSink()
    try {
      await invokeFn(this.rpcDataSource, dataSink)
    } catch (err) {
      this.close(err as Error)
    }
  }

  // _createDataSink creates a sink for outgoing data packets.
  private _createDataSink(): Sink<Source<Uint8Array>> {
    return async (source) => {
      try {
        for await (const msg of source) {
          await this.writeCallData(msg)
        }
        await this.writeCallData(undefined, true)
        this.close()
      } catch (err) {
        this.close(err as Error)
      }
    }
  }
}
