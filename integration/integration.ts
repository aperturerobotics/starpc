import { WebSocketConn } from '../dist/srpc/websocket.js'
import { EchoerClientImpl } from '../dist/echo/echo.js'
import WebSocket from 'isomorphic-ws'

async function runRPC() {
  const addr = 'ws://localhost:5000/demo'
  console.log(`Connecting to ${addr}`)
  const ws = new WebSocket(addr)
  const channel = new WebSocketConn(ws)
  const client = channel.buildClient()
  const demoServiceClient = new EchoerClientImpl(client)

  console.log('Calling Echo...')
  const result = await demoServiceClient.Echo({
    body: "Hello world!"
  })
  console.log('output', result.body)
}

runRPC().then(() => {
  process.exit(0)
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
