import net from 'net'
import { closeSync, openSync, writeSync } from 'node:fs'
import { pipe } from 'it-pipe'
import { pushable } from 'it-pushable'
import { createMux, createHandler, Server } from '../../srpc/index.js'
import {
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from '../../srpc/packet.js'
import { combineUint8ArrayListTransform } from '../../srpc/array-list.js'
import { EchoerServer, EchoMsg } from '../../echo/index.js'
import { EchoerDefinition } from '../../echo/echo_srpc.pb.js'
import { Packet, TerminalKind } from '../../srpc/rpcproto.pb.js'
import type { PacketStream } from '../../srpc/stream.js'
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
        const data = chunk instanceof Uint8Array ? chunk : chunk.subarray()
        const packet = Packet.fromBinary(data.subarray(4))
        const receiptCompletion =
          receiptMode &&
          packet.body?.case === 'callData' &&
          packet.body.value.complete &&
          !packet.body.value.error
        const writeDone = new Promise<void>((resolve, reject) => {
          socket.write(data, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        if (receiptCompletion) {
          emitReceiptEvent('SERVER_RECEIPT_ACK committed')
        }
        await writeDone
        if (receiptCompletion) {
          finishReceiptServer()
        }
      }
      socket.end()
    },
  }
}

const mux = createMux()
const receiptMode = process.argv[2] === 'receipt'
const receiptCase = receiptMode ? process.argv[3] : undefined
if (
  receiptMode &&
  !['commit', 'abort', 'loss', 'bare-close'].includes(receiptCase ?? '')
) {
  console.error(`unknown receipt case: ${receiptCase}`)
  process.exit(1)
}

const receiptServerDone = Promise.withResolvers<void>()
let receiptServerFinished = false
function finishReceiptServer(): void {
  if (!receiptServerFinished) {
    receiptServerFinished = true
    receiptServerDone.resolve()
  }
}

if (receiptMode) {
  mux.registerLookupMethod(async (serviceID, methodID) => {
    if (serviceID !== 'echo.Echoer' || methodID !== 'Echo') {
      return null
    }
    return async (dataSource, dataSink, invocation) => {
      let requestData: Uint8Array | undefined
      for await (const data of dataSource) {
        requestData = data
        break
      }
      if (!requestData) {
        throw new Error('receipt request was empty')
      }
      const requestMsg = EchoMsg.fromBinary(requestData)
      await dataSink(
        (async function* () {
          yield EchoMsg.toBinary(requestMsg)
          if (!invocation) {
            throw new Error('receipt invocation was missing')
          }
          emitReceiptEvent('SERVER_RECEIPT_WAITING')
          const terminal = await invocation.waitTerminal(
            new AbortController().signal,
          )
          emitReceiptEvent(`SERVER_RECEIPT_TERMINAL ${terminalName(terminal)}`)
          if (terminal !== TerminalKind.COMMITTED) {
            finishReceiptServer()
          }
        })(),
      )
    }
  })
}

function terminalName(terminal: TerminalKind): string {
  switch (terminal) {
    case TerminalKind.COMMITTED:
      return 'committed'
    case TerminalKind.CANCELED:
      return 'canceled'
    case TerminalKind.TRANSPORT_LOST:
      return 'transportLost'
    case TerminalKind.CLOSED:
      return 'closed'
    case TerminalKind.ABANDONED:
      return 'abandoned'
    default:
      return 'unknown'
  }
}
const server = new Server(mux.lookupMethod)
if (!receiptMode) {
  const echoer = new EchoerServer(server)
  mux.register(createHandler(EchoerDefinition, echoer))
}

const tcpServer = net.createServer((socket) => {
  const stream = tcpSocketToPacketStream(socket)
  server.handlePacketStream(stream)
})

tcpServer.listen(0, '127.0.0.1', () => {
  const addr = tcpServer.address() as net.AddressInfo
  console.log(`LISTENING ${addr.address}:${addr.port}`)
})

if (receiptMode) {
  void receiptServerDone.promise.then(() => {
    tcpServer.close()
  })
}

process.on('SIGINT', () => {
  tcpServer.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  tcpServer.close()
  process.exit(0)
})
