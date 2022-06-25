import { Observable, from as observableFrom } from 'rxjs'
import { Echoer, EchoMsg } from './echo.pb.js'
import { pushable, Pushable } from 'it-pushable'

// EchoServer implements the Echoer server.
export class EchoerServer implements Echoer {
  public async Echo(request: EchoMsg): Promise<EchoMsg> {
    return request
  }

  public EchoServerStream(request: EchoMsg): Observable<EchoMsg> {
    // send 5 responses, with a 200ms delay for each
    return observableFrom(
      (async function* response(): AsyncIterable<EchoMsg> {
        for (let i = 0; i < 5; i++) {
          yield request
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      })()
    )
  }

  public EchoClientStream(request: Observable<EchoMsg>): Promise<EchoMsg> {
    return new Promise<EchoMsg>((resolve, reject) => {
      request.subscribe({
        next(msg) {
          resolve(msg)
        },
        error(err: any) {
          reject(err)
        },
        complete() {
          reject(new Error('none received'))
        },
      })
    })
  }

  public EchoBidiStream(request: Observable<EchoMsg>): Observable<EchoMsg> {
    // build result observable
    const pushResponse: Pushable<EchoMsg> = pushable({ objectMode: true })
    const response = observableFrom(pushResponse)
    pushResponse.push({ body: 'hello from server' })
    request.subscribe({
      next(msg) {
        pushResponse.push(msg)
      },
      error(err) {
        pushResponse.throw(err)
      },
      complete() {
        pushResponse.end()
      },
    })
    return response
  }
}
