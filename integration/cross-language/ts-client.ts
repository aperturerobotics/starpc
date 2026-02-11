import net from 'net'
import { pipe } from 'it-pipe'
import { pushable } from 'it-pushable'
import { Client } from '../../srpc/client.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from '../../srpc/packet.js'
import { combineUint8ArrayListTransform } from '../../srpc/array-list.js'
import { runClientTest } from '../../echo/client-test.js'
import type { OpenStreamFunc, PacketStream } from '../../srpc/stream.js'
import type { Source } from 'it-stream-types'

// tcpSocketToPacketStream wraps a Node.js TCP socket into a PacketStream.
function tcpSocketToPacketStream(socket: net.Socket): PacketStream {
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

async function main() {
  const addr = process.argv[2]
  if (!addr) {
    console.error('usage: ts-client <host:port>')
    process.exit(1)
  }

  const [host, portStr] = addr.split(':')
  const port = parseInt(portStr, 10)

  const openStream: OpenStreamFunc = async (): Promise<PacketStream> => {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host, () => {
        resolve(tcpSocketToPacketStream(socket))
      })
      socket.on('error', reject)
    })
  }

  const client = new Client(openStream)

  console.log('Running client test via TCP...')
  await runClientTest(client)
  console.log('All tests passed.')
  process.exit(0)
}

process.on('unhandledRejection', (ev) => {
  console.error('Unhandled rejection', ev)
  process.exit(1)
})

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
