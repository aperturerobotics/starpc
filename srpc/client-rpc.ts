import type { CompleteMessage } from '@aptre/protobuf-es-lite'
import type { CallStart } from './rpcproto_pb.js'
import { CommonRPC } from './common-rpc.js'

// ClientRPC is an ongoing RPC from the client side.
export class ClientRPC extends CommonRPC {
  constructor(service: string, method: string) {
    super()
    this.service = service
    this.method = method
  }

  // writeCallStart writes the call start packet.
  // if data === undefined and data.length === 0 sends empty data packet.
  public async writeCallStart(data?: Uint8Array) {
    if (!this.service || !this.method) {
      throw new Error('service and method must be set')
    }
    const callStart: CompleteMessage<CallStart> = {
      rpcService: this.service,
      rpcMethod: this.method,
      data: data || new Uint8Array(0),
      dataIsZero: !!data && data.length === 0,
    }
    await this.writePacket({
      body: {
        case: 'callStart',
        value: callStart,
      },
    })
  }

  // handleCallStart handles a CallStart packet.
  public override async handleCallStart(packet: CallStart) {
    // we do not implement server -> client RPCs.
    throw new Error(
      `unexpected server to client rpc: ${packet.rpcService || '<empty>'}/${packet.rpcMethod || '<empty>'}`,
    )
  }
}
