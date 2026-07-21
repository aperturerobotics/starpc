import net from 'net'
import { closeSync, openSync, writeSync } from 'node:fs'
import { pipe } from 'it-pipe'
import { pushable } from 'it-pushable'
import { Client } from '../../srpc/client.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from '../../srpc/packet.js'
import { combineUint8ArrayListTransform } from '../../srpc/array-list.js'
import { EchoMsg, runClientTest } from '../../echo/index.js'
import type { OpenStreamFunc, PacketStream } from '../../srpc/stream.js'
import type { Source } from 'it-stream-types'
function emitReceiptEvent(line: string): void {
  console.log(line)
  const fifo = process.env.RECEIPT_EVENT_FIFO
  if (!fifo) {
    return
  }
  const fd = openSync(fifo, 'w')
  try {
    writeSync(fd, `${line}\n`)
  } finally {
    closeSync(fd)
  }
}

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
        const data = chunk instanceof Uint8Array ? chunk : chunk.subarray()
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
  const receiptMode = process.argv[2] === 'receipt'
  const receiptCase = receiptMode ? process.argv[3] : undefined
  const addr = receiptMode ? process.argv[4] : process.argv[2]
  if (!addr) {
    console.error('usage: ts-client [receipt <case>] <host:port>')
    process.exit(1)
  }
  if (
    receiptMode &&
    !['commit', 'abort', 'loss', 'bare-close'].includes(receiptCase ?? '')
  ) {
    throw new Error(`unknown receipt case: ${receiptCase}`)
  }

  const [host, portStr] = addr.split(':')
  const port = parseInt(portStr, 10)
  let activeSocket: net.Socket | undefined

  const openStream: OpenStreamFunc = async (): Promise<PacketStream> => {
    const { promise, resolve, reject } = Promise.withResolvers<PacketStream>()
    const socket = net.connect(port, host, () => {
      activeSocket = socket
      resolve(tcpSocketToPacketStream(socket))
    })
    socket.on('error', reject)
    return promise
  }

  const client = new Client(openStream)

  if (receiptMode) {
    console.log(`Running held receipt test via TCP (${receiptCase})...`)
    const request = EchoMsg.create({ body: 'held receipt' })
    const held = await client.requestWithReceipt(
      'echo.Echoer',
      'Echo',
      EchoMsg.toBinary(request),
    )
    const result = EchoMsg.fromBinary(held.response)
    if (result.body !== request.body) {
      throw new Error(`expected ${request.body}, got ${result.body}`)
    }
    switch (receiptCase) {
      case 'commit':
        await held.receipt.commit()
        break
      case 'abort':
        await held.receipt.abort()
        break
      case 'loss':
        activeSocket?.resetAndDestroy()
        await expectReceiptFailure(held.receipt)
        break
      case 'bare-close':
        activeSocket?.end()
        await expectReceiptFailure(held.receipt)
        break
    }
    emitReceiptEvent(
      `CLIENT_RECEIPT_RESOLVED ${receiptTerminalName(receiptCase ?? '')}`,
    )
  } else {
    console.log('Running client test via TCP...')
    await runClientTest(client)
  }
  console.log('All tests passed.')
}

function receiptTerminalName(receiptCase: string): string {
  switch (receiptCase) {
    case 'commit':
      return 'committed'
    case 'abort':
      return 'canceled'
    case 'loss':
      return 'transportLost'
    case 'bare-close':
      return 'closed'
    default:
      return 'unknown'
  }
}

async function expectReceiptFailure(receipt: {
  commit(): Promise<void>
}): Promise<void> {
  try {
    await receipt.commit()
  } catch {
    return
  }
  throw new Error('receipt commit unexpectedly succeeded')
}

process.on('unhandledRejection', (ev) => {
  console.error('Unhandled rejection', ev)
  process.exit(1)
})

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
