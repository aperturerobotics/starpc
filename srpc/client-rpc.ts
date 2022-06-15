import type { CallData, CallStart, CallStartResp } from './rpcproto'
import { Packet } from './rpcproto'
import type { Sink } from 'it-stream-types'
import { pushable } from 'it-pushable'

// DataCb is a callback to handle incoming RPC messages.
// Returns true if more data is expected, false otherwise.
// If returns undefined, assumes more data is expected.
export type DataCb = (data: Uint8Array) => Promise<boolean | void>

// ClientRPC is an ongoing RPC from the client side.
export class ClientRPC {
  // sink is the data sink for incoming messages.
  public sink: Sink<Packet>
  // source is the packet source for outgoing Packets.
  public source: AsyncIterable<Packet>
  // _source is used to write to the source.
  private readonly _source: {
    push: (val: Packet) => void
    end: (err?: Error) => void
  }
  // service is the rpc service
  private service: string
  // method is the rpc method
  private method: string
  // dataCb is called with any incoming data.
  private dataCb?: DataCb
  // started is resolved when the request starts.
  private started: Promise<void>
  // onStarted is called by the message handler when the request starts.
  private onStarted?: (err?: Error) => void
  // complete is resolved when the request completes.
  // rejected with an error if the call encountered any error.
  private complete: Promise<void>
  // onComplete is called by the message handler when the call completes.
  private onComplete?: (err?: Error) => void
  // closed indicates close has been called
  private closed: boolean

  constructor(service: string, method: string, dataCb: DataCb | null) {
    this.closed = false
    this.sink = this._createSink()
    const sourcev = this._createSource()
    this.source = sourcev
    this._source = sourcev
    this.service = service
    this.method = method
    if (dataCb) {
      this.dataCb = dataCb
    }
    this.started = new Promise<void>((resolveStarted, rejectStarted) => {
      this.onStarted = (err?: Error) => {
        if (err) {
          rejectStarted(err)
        } else {
          resolveStarted()
        }
      }
    })
    this.complete = new Promise<void>((resolveComplete, rejectComplete) => {
      this.onComplete = (err?: Error) => {
        this.closed = true
        if (err) {
          rejectComplete(err)
        } else {
          resolveComplete()
        }
      }
    })
  }

  // waitStarted returns the started promise.
  public waitStarted(): Promise<void> {
    return this.started
  }

  // waitComplete returns the complete promise.
  public waitComplete(): Promise<void> {
    return this.complete
  }

  // writeCallStart writes the call start packet.
  public async writeCallStart(data?: Uint8Array) {
    const callStart: CallStart = {
      rpcService: this.service,
      rpcMethod: this.method,
      data: data || new Uint8Array(0),
    }
    await this.writePacket({
      body: {
        $case: 'callStart',
        callStart,
      },
    })
  }

  // writeCallData writes the call data packet.
  public async writeCallData(data: Uint8Array, complete?: boolean, error?: string) {
    const callData: CallData = {
      data,
      complete: complete || false,
      error: error || "",
    }
    await this.writePacket({
      body: {
        $case: 'callData',
        callData,
      },
    })
  }

  // writePacket writes a packet to the stream.
  private async writePacket(packet: Packet) {
    this._source.push(packet)
  }

  // handleMessage handles an incoming encoded Packet.
  //
  // note: may throw an error if the message was unexpected or invalid.
  public async handleMessage(message: Uint8Array) {
    return this.handlePacket(Packet.decode(message))
  }

  // handlePacket handles an incoming packet.
  public async handlePacket(packet: Partial<Packet>) {
    switch (packet?.body?.$case) {
      case 'callStart':
        return this.handleCallStart(packet.body.callStart)
      case 'callStartResp':
        return this.handleCallStartResp(packet.body.callStartResp)
      case 'callData':
        return this.handleCallData(packet.body.callData)
    }
  }

  // handleCallStart handles a CallStart packet.
  public async handleCallStart(packet: Partial<CallStart>) {
    // we do not implement server -> client RPCs.
    throw new Error(`unexpected server to client rpc: ${packet.rpcService}/${packet.rpcMethod}`)
  }

  // handleCallStartResp handles a CallStartResp packet.
  public async handleCallStartResp(packet: Partial<CallStartResp>) {
    if (packet.error && packet.error.length) {
      const err = new Error(packet.error)
      this.onStarted!(err)
      this.onComplete!(err)
    }
  }

  // handleCallData handles a CallData packet.
  public async handleCallData(packet: Partial<CallData>) {
    const data = packet.data
    if (this.dataCb && data?.length) {
      await this.dataCb(data)
    }
    if (packet.error && packet.error.length) {
      this.onComplete!(new Error(packet.error))
    } else if (packet.complete) {
      this.onComplete!()
    }
  }

  // close closes the active call if not already completed.
  public async close(err?: Error) {
    if (!this.closed) {
      await this.writeCallData(new Uint8Array(0), true, err ? err.message : "")
    }
    if (!err) {
      err = new Error('call closed')
    }
    this.onComplete!(err)
  }

  // _createSink initializes the sink field.
  private _createSink(): Sink<Packet> {
    return async (source) => {
      try {
        for await (const msg of source) {
          await this.handlePacket(msg)
        }
      } catch (err) {
        this.close(err as Error)
      }
    }
  }

  // _createSource initializes the source field.
  private _createSource() {
    return pushable<Packet>({
      objectMode: true,
      onEnd: (err?: Error): void => {
        this.onComplete!(err)
      },
    })
  }
}
