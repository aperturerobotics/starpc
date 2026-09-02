import net from 'net'
import { pushable } from 'it-pushable'
import { Client } from '../../srpc/client.js'
import {
  runClientTest,
  runAbortControllerTest,
  runRpcStreamTest,
} from '../../echo/client-test.js'
import { EchoerClient } from '../../echo/echo_srpc.pb.js'
import type { OpenStreamFunc, PacketStream } from '../../srpc/stream.js'
import { tcpSocketToPacketStream } from './tcp-packet-stream.js'

async function runEchoBidiStreamTest(client: Client): Promise<void> {
  const request = pushable<{ body: string }>({ objectMode: true })
  const stream = new EchoerClient(client).EchoBidiStream(request)
  const iterator = stream[Symbol.asyncIterator]()

  const initial = await iterator.next()
  if (initial.done || initial.value.body !== 'hello from server') {
    throw new Error('expected initial bidi message "hello from server"')
  }

  const body = 'hello from TypeScript bidi client'
  request.push({ body })
  request.end()

  const echo = await iterator.next()
  if (echo.done || echo.value.body !== body) {
    throw new Error(`expected bidi echo ${JSON.stringify(body)}`)
  }

  const terminal = await iterator.next()
  if (!terminal.done) {
    throw new Error('expected bidi stream to terminate after input closes')
  }
}

function parseAddr(addr: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(addr)
  if (!match) {
    throw new Error(`invalid host:port address: ${addr}`)
  }

  const port = Number(match[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${match[3]}`)
  }

  return { host: match[1] ?? match[2], port }
}

async function main() {
  const args = process.argv.slice(2)
  const lifecycle = args.includes('lifecycle')
  const nested = args.includes('--nested') || args.includes('--nested-release')
  const nestedRelease = args.includes('--nested-release')
  const addr = args.find(
    (arg) =>
      arg !== 'lifecycle' && arg !== '--nested' && arg !== '--nested-release',
  )
  if (!addr) {
    console.error(
      'usage: ts-client [--nested] [--nested-release] [lifecycle] <host:port>',
    )
    process.exit(1)
  }

  const { host, port } = parseAddr(addr)
  const openStream: OpenStreamFunc = async (): Promise<PacketStream> => {
    const { promise, resolve, reject } = Promise.withResolvers<PacketStream>()
    const socket = net.connect(port, host, () => {
      resolve(tcpSocketToPacketStream(socket))
    })
    socket.on('error', reject)
    return promise
  }

  const client = new Client(openStream)
  console.log('Running client test via TCP...')
  await runClientTest(client)
  console.log('Running EchoBidiStream test via TCP...')
  await runEchoBidiStreamTest(client)
  if (lifecycle) {
    console.log('Running abort controller test via TCP...')
    await runAbortControllerTest(client)
  }
  if (nested) {
    console.log('Running RpcStream test via TCP...')
    await runRpcStreamTest(client, nestedRelease)
  }
  console.log('All tests passed.')
}

process.on('unhandledRejection', (ev) => {
  console.error('Unhandled rejection', ev)
  process.exit(1)
})

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
