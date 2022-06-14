import { WebSocketConn } from '../dist/srpc/websocket.js'
import { EchoerClientImpl, EchoMsg } from '../dist/echo/echo.js'
import WebSocket from 'isomorphic-ws'
import { Observable } from 'rxjs'

async function runRPC() {
  const addr = 'ws://localhost:5000/demo'
  console.log(`Connecting to ${addr}`)
  const ws = new WebSocket(addr)
  const channel = new WebSocketConn(ws)
  const client = channel.buildClient()
  const demoServiceClient = new EchoerClientImpl(client)

  console.log('Calling Echo: unary call...')
  let result = await demoServiceClient.Echo({
    body: "Hello world!"
  })
  console.log('success: output', result.body)

  // observable for client requests
  const clientRequestStream = new Observable<EchoMsg>(subscriber => {
    subscriber.next({body: 'Hello world from streaming request.'})
    subscriber.complete()
  })

  console.log('Calling EchoClientStream: client -> server...')
  result = await demoServiceClient.EchoClientStream(clientRequestStream)
  console.log('success: output', result.body)

  console.log('Calling EchoServerStream: server -> client...')
  const serverStream = demoServiceClient.EchoServerStream({
    body: 'Hello world from server to client streaming request.',
  })
  await new Promise<void>((resolve, reject) => {
    serverStream.subscribe({
      next(result) {
        console.log('server: output', result.body)
      },
      complete() {
        resolve()
      },
      error(err: Error) {
        reject(err)
      },
    })
  })
}

runRPC().then(() => {
  process.exit(0)
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
