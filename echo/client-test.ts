import { Client } from '../srpc/index.js'
import { EchoerClientImpl, EchoMsg } from './echo.pb.js'
import { Observable } from 'rxjs'

export async function runClientTest(client: Client) {
  const demoServiceClient = new EchoerClientImpl(client)

  console.log('Calling Echo: unary call...')
  let result = await demoServiceClient.Echo({
    body: 'Hello world!',
  })
  console.log('success: output', result.body)

  // observable for client requests
  const clientRequestStream = new Observable<EchoMsg>((subscriber) => {
    subscriber.next({ body: 'Hello world from streaming request.' })
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
