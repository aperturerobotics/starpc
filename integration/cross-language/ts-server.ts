import net from 'net'
import { pipe } from 'it-pipe'
import { pushable } from 'it-pushable'
import { createMux, createHandler, Server } from '../../srpc/index.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from '../../srpc/packet.js'
import { combineUint8ArrayListTransform } from '../../srpc/array-list.js'
import { EchoerServer } from '../../echo/server.js'
import { EchoerDefinition } from '../../echo/echo_srpc.pb.js'
import type { PacketStream } from '../../srpc/stream.js'
import type { Source } from 'it-stream-types'

// tcpSocketToPacketStream wraps a Node.js TCP socket into a PacketStream.
// Each Uint8Array in source/sink is one packet (no length prefix).
function tcpSocketToPacketStream(socket: net.Socket): PacketStream {
  // Source: read from socket, strip length prefix, yield individual packets.
  const socketSource = async function* (): AsyncGenerator<Uint8Array> {
    const source = pushable<Uint8Array>({ objectMode: true })
    socket.on('data', (data: Buffer) => {
      source.push(new Uint8Array(data))
    })
    socket.on('end', () => source.end())
    socket.on('error', (err) => source.end(err))
    socket.on('close', () => source.end())
    yield* pipe(
      source,
      parseLengthPrefixTransform(),
      combineUint8ArrayListTransform(),
    )
  }

  return {
    source: socketSource(),
    sink: async (source: Source<Uint8Array>): Promise<void> => {
      for await (const chunk of pipe(source, prependLengthPrefixTransform())) {
        const data =
          chunk instanceof Uint8Array ? chunk : (chunk as any).subarray()
        await new Promise<void>((resolve, reject) => {
          socket.write(data, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }
      socket.end()
    },
  }
}

const mux = createMux()
const server = new Server(mux.lookupMethod)
const echoer = new EchoerServer(server)
mux.register(createHandler(EchoerDefinition, echoer))

const tcpServer = net.createServer((socket) => {
  const stream = tcpSocketToPacketStream(socket)
  server.handlePacketStream(stream)
})

tcpServer.listen(0, '127.0.0.1', () => {
  const addr = tcpServer.address() as net.AddressInfo
  console.log(`LISTENING ${addr.address}:${addr.port}`)
})

process.on('SIGINT', () => {
  tcpServer.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  tcpServer.close()
  process.exit(0)
})
