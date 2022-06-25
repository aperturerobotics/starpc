import { Source } from 'it-stream-types'
import { pushable, Pushable } from 'it-pushable'
import { Observable, Subscription } from 'rxjs'

// ObservableSource wraps an Observable into a Source.
export class ObservableSource<T> {
  // source is the source for observable objects.
  public readonly source: Source<T>
  // _source emits incoming data to the source.
  private readonly _source: {
    push: (val: T) => void
    end: (err?: Error) => void
  }
  // subscription is the observable subscription
  private readonly subscription: Subscription

  constructor(observable: Observable<T>) {
    const source: Pushable<T> = pushable({ objectMode: true })
    this.source = source
    this._source = source

    this.subscription = observable.subscribe({
      next: (value: T) => {
        this._source.push(value)
      },
      error: (err) => {
        this._source.end(err)
      },
      complete: () => {
        this._source.end()
      },
    })
  }

  // close closes the subscription.
  public close(err?: Error) {
    this._source.end(err)
    this.subscription.unsubscribe()
  }
}
