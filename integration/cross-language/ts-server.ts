import net from 'net'

import { createMux, createHandler, Server } from '../../srpc/index.js'
import { EchoerServer } from '../../echo/index.js'
import { EchoerDefinition } from '../../echo/echo_srpc.pb.js'
import { tcpSocketToPacketStream } from './tcp-packet-stream.js'

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
