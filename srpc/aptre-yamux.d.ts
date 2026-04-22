import type { ComponentLogger, StreamMuxerFactory } from './stream-muxer.js'

declare module '@aptre/yamux' {
  export interface YamuxMuxerInit {
    enableKeepAlive?: boolean
    keepAliveInterval?: number
    maxInboundStreams?: number
    maxOutboundStreams?: number
    initialStreamWindowSize?: number
    maxStreamWindowSize?: number
    maxMessageSize?: number
  }

  export interface YamuxMuxerComponents {
    logger: ComponentLogger
  }

  export function yamux(
    init?: YamuxMuxerInit,
  ): (components: YamuxMuxerComponents) => StreamMuxerFactory
}
