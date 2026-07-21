/// <reference lib="es2024.promise" />
import type { Sink, Source } from 'it-stream-types'
import { pushable, type Pushable } from 'it-pushable'
import { CompleteMessage } from '@aptre/protobuf-es-lite'

import {
  Packet,
  TerminalKind,
  type CallData,
  type CallStart,
} from './rpcproto.pb.js'
import { ERR_RPC_ABORT, RemoteRPCError } from './errors.js'

const maxBufferedOutgoingPackets = 1

// CommonRPC is common logic between server and client RPCs.
export class CommonRPC {
  // sink is the data sink for incoming messages.
  public readonly sink: Sink<Source<Packet>>
  // source is the packet source for outgoing Packets.
  public readonly source: AsyncIterable<Packet>
  // rpcDataSource is the source for rpc packets.
  public readonly rpcDataSource: AsyncIterable<Uint8Array>

  // _source is used to write to the source.
  private readonly _source: Pushable<Packet> = pushable<Packet>({
    objectMode: true,
  })

  // _rpcDataSource is used to write to the rpc message source.
  private readonly _rpcDataSource = pushable<Uint8Array>({
    objectMode: true,
  })

  // service is the rpc service
  protected service?: string
  // method is the rpc method
  protected method?: string

  // closed indicates this rpc has been closed already.
  private closed?: true | Error
  // remoteCompleted is set only by an explicit remote CallData completion.
  private remoteCompleted = false
  // remoteError records a remote error or transport failure.
  private remoteError?: Error
  // remoteSourceClosed records an incoming source ending without a packet error.
  private remoteSourceClosed = false
  // remoteTerminal is the first valid remote terminal.
  private remoteTerminal?: TerminalKind
  // invocationController cancels the server invocation on a remote terminal.
  private readonly invocationController = new AbortController()
  // terminalPromise resolves when a remote terminal is recorded.
  private readonly terminalPromise: Promise<void>
  private resolveTerminal!: () => void

  // writeDrainAbort wakes writers waiting for outbound stream drain on close.
  private readonly writeDrainAbort = new AbortController()

  constructor() {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.terminalPromise = promise
    this.resolveTerminal = resolve
    this.sink = this._createSink()
    this.source = this._source
    this.rpcDataSource = this._rpcDataSource
  }

  // isClosed returns one of: true (closed w/o error), Error (closed w/ error), or false (not closed).
  public get isClosed(): boolean | Error {
    return this.closed ?? false
  }

  // invocationSignal is canceled when the RPC reaches a terminal.
  protected get invocationSignal(): AbortSignal {
    return this.invocationController.signal
  }

  // waitTerminal waits for the remote terminal or external owner cancellation.
  protected async waitTerminal(
    ownerSignal: AbortSignal,
  ): Promise<TerminalKind> {
    const { promise: ownerDone, resolve: resolveOwnerDone } =
      Promise.withResolvers<void>()
    const onAbort = () => resolveOwnerDone()
    ownerSignal.addEventListener('abort', onAbort, { once: true })
    let ownerAborted = ownerSignal.aborted
    try {
      for (;;) {
        const terminal = this.getTerminalKind()
        if (terminal !== undefined) {
          if (
            terminal === TerminalKind.CLOSED &&
            this.remoteSourceClosed &&
            !this.closed
          ) {
            await this.close()
          }
          return terminal
        }
        if (ownerAborted) {
          return TerminalKind.ABANDONED
        }
        await Promise.race([this.terminalPromise, ownerDone])
        ownerAborted = ownerSignal.aborted
      }
    } finally {
      ownerSignal.removeEventListener('abort', onAbort)
    }
  }

  // getTerminalKind returns the observed remote terminal, if any.
  public getTerminalKind(): TerminalKind | undefined {
    return this.remoteTerminal
  }

  private recordRemoteTerminal(kind: TerminalKind) {
    if (this.remoteTerminal !== undefined) {
      return
    }
    this.remoteTerminal = kind
    this.resolveTerminal()
  }

  // writeCallData writes the call data packet.
  public async writeCallData(
    data?: Uint8Array,
    complete?: boolean,
    error?: string,
  ) {
    await this.writeCallDataPacket(data, complete, error)
  }

  // writeCallDataPacket writes a call-data packet with optional drain control.
  private async writeCallDataPacket(
    data?: Uint8Array,
    complete?: boolean,
    error?: string,
    writeOptions?: WritePacketOptions,
  ) {
    const callData: CompleteMessage<CallData> = {
      data: data || new Uint8Array(0),
      dataIsZero: !!data && data.length === 0,
      complete: complete || false,
      error: error || '',
    }
    await this.writePacket(
      {
        body: {
          case: 'callData',
          value: callData,
        },
      },
      writeOptions,
    )
  }

  // writeCallCancel writes the call cancel packet.
  public async writeCallCancel(waitForDrain = false) {
    await this.writePacket(
      {
        body: {
          case: 'callCancel',
          value: true,
        },
      },
      { waitForDrain: false },
    )
    if (waitForDrain) {
      await this._source.onEmpty({ signal: this.writeDrainAbort.signal })
    }
  }

  // writeCallDataFromSource writes all call data from the iterable.
  public async writeCallDataFromSource(dataSource: AsyncIterable<Uint8Array>) {
    try {
      for await (const data of dataSource) {
        await this.writeCallData(data)
      }
      await this.writeCallData(undefined, true)
    } catch (err) {
      this.close(err as Error)
    }
  }

  // writePacket writes a packet to the stream.
  protected async writePacket(packet: Packet, options?: WritePacketOptions) {
    if (this.closed && !options?.allowClosed) {
      throw new Error(ERR_RPC_ABORT)
    }
    this._source.push(packet)
    if (
      options?.waitForDrain === false ||
      this._source.readableLength <= maxBufferedOutgoingPackets
    ) {
      return
    }
    try {
      await this._source.onEmpty({ signal: this.writeDrainAbort.signal })
    } catch (err) {
      if (this.closed) {
        throw new Error(ERR_RPC_ABORT, { cause: err })
      }
      throw err
    }
  }

  // handleMessage handles an incoming encoded Packet.
  //
  // note: closes the stream if any error is thrown.
  public async handleMessage(message: Uint8Array) {
    return this.handlePacket(Packet.fromBinary(message))
  }

  // handlePacket handles an incoming packet.
  //
  // note: closes the stream if any error is thrown.
  public async handlePacket(packet: Packet) {
    // console.log('handlePacket', packet)
    try {
      switch (packet?.body?.case) {
        case 'callStart':
          await this.handleCallStart(packet.body.value)
          break
        case 'callData':
          await this.handleCallData(packet.body.value)
          break
        case 'callCancel':
          if (packet.body.value) {
            await this.handleCallCancel()
          }
          break
      }
    } catch (err) {
      let asError = err as Error
      if (!asError?.message) {
        asError = new Error('error handling packet')
      }
      this.close(asError)
      // throw asError
    }
  }

  // handleCallStart handles a CallStart packet.
  public async handleCallStart(packet: Partial<CallStart>) {
    // no-op
    throw new Error(
      `unexpected call start: ${packet.rpcService}/${packet.rpcMethod}`,
    )
  }

  // pushRpcData pushes incoming rpc data to the rpc data source.
  protected pushRpcData(
    data: Uint8Array | undefined,
    dataIsZero: boolean | undefined,
  ) {
    if (dataIsZero) {
      if (!data || data.length !== 0) {
        data = new Uint8Array(0)
      }
    } else if (!data || data.length === 0) {
      return
    }
    this._rpcDataSource.push(data)
  }

  // handleCallData handles a CallData packet.
  public async handleCallData(packet: Partial<CallData>) {
    if (!this.service || !this.method) {
      throw new Error('call start must be sent before call data')
    }

    this.pushRpcData(packet.data, packet.dataIsZero)
    const remoteError =
      packet.error ?
        new RemoteRPCError(this.service, this.method, packet.error)
      : undefined
    if (remoteError) {
      this.remoteError ??= remoteError
      this.invocationController.abort()
      this.recordRemoteTerminal(TerminalKind.TRANSPORT_LOST)
    }
    if (packet.complete && !remoteError) {
      this.remoteCompleted = true
      this.recordRemoteTerminal(TerminalKind.COMMITTED)
      this._rpcDataSource.end(remoteError)
    } else if (remoteError) {
      this._rpcDataSource.end(remoteError)
    }
  }

  // handleCallCancel handles a CallCancel packet.
  public async handleCallCancel() {
    this.recordRemoteTerminal(TerminalKind.CANCELED)
    await this.close(new Error(ERR_RPC_ABORT))
  }

  // close closes the call, optionally with an error.
  public async close(err?: Error) {
    if (this.closed) {
      return
    }
    this.closed = err ?? true
    if (!this.remoteError && err) {
      this.remoteError = err
    }
    this.recordRemoteTerminal(
      err ? TerminalKind.TRANSPORT_LOST : TerminalKind.CLOSED,
    )
    this.invocationController.abort()
    // note: this does nothing if _source is already ended.
    if (err && err.message) {
      await this.writeCallDataPacket(undefined, true, err.message, {
        allowClosed: true,
        waitForDrain: false,
      })
    }
    this.writeDrainAbort.abort()
    this._source.end()
    this._rpcDataSource.end(err)
  }

  private _createSink(): Sink<Source<Packet>> {
    return async (source: Source<Packet>) => {
      try {
        if (Symbol.asyncIterator in source) {
          for await (const msg of source) {
            await this.handlePacket(msg)
          }
        } else {
          for (const msg of source) {
            await this.handlePacket(msg)
          }
        }
        this.remoteSourceClosed = true
        this.recordRemoteTerminal(TerminalKind.CLOSED)
      } catch (err) {
        this.close(err as Error)
      }
    }
  }
}

interface WritePacketOptions {
  allowClosed?: boolean
  waitForDrain?: boolean
}
