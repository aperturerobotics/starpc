import type { Duplex, Source } from 'it-stream-types'

// Direction describes which side initiated a muxed connection or stream.
export type Direction = 'inbound' | 'outbound'

// AbortOptions carries an optional abort signal.
export interface AbortOptions {
  signal?: AbortSignal
}

// Logger is the minimal callable logger surface used by the muxer stack.
export interface Logger {
  (formatter: any, ...args: any[]): void
  error(formatter: any, ...args: any[]): void
  trace(formatter: any, ...args: any[]): void
  enabled: boolean
  newScope(name: string): Logger
}

// ComponentLogger builds per-component loggers.
export interface ComponentLogger {
  forComponent(name: string): Logger
}

// Stream is the supported duplex stream shape accepted by StreamConn.
export interface Stream extends Duplex<
  AsyncGenerator<any>,
  Source<any>,
  Promise<void>
> {
  close(options?: AbortOptions): Promise<void>
  closeRead(options?: AbortOptions): Promise<void>
  closeWrite(options?: AbortOptions): Promise<void>
  abort(err: Error): void
}

// StreamMuxerInit configures an individual muxer instance.
export interface StreamMuxerInit {
  onIncomingStream?(stream: Stream): void
  onStreamEnd?(stream: Stream): void
  direction?: Direction
  log?: Logger
}

// StreamMuxerFactory constructs stream muxers over a duplex transport.
export interface StreamMuxerFactory {
  protocol: string
  createStreamMuxer(init?: StreamMuxerInit): StreamMuxer
}

// StreamMuxer is the supported multiplexed transport surface.
export interface StreamMuxer extends Duplex<AsyncGenerator<any>> {
  protocol: string
  readonly streams: Stream[]
  newStream(name?: string): Stream | Promise<Stream>
  close(options?: AbortOptions): Promise<void>
  abort(err: Error): void
}
