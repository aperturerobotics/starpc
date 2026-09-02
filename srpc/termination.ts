import type { Source } from 'it-stream-types'

type Terminated = { terminated: true; error?: Error }
type Received<T> = { result: IteratorResult<T> } | { error: unknown }
type WaitResult<T> = { result: T } | { error: unknown }

// TerminationGate makes the first clean close or abort visible to blocked I/O.
export class TerminationGate {
  private readonly _waiters = new Set<(error?: Error) => void>()
  private _error: Error | undefined
  private _terminated = false

  public get terminated(): boolean {
    return this._terminated
  }

  public terminate(error?: Error): boolean {
    if (this._terminated) return false
    this._terminated = true
    this._error = error
    for (const waiter of this._waiters) waiter(error)
    this._waiters.clear()
    return true
  }

  public async wait<T>(
    promise: Promise<T>,
  ): Promise<WaitResult<T> | Terminated> {
    if (this._terminated) return { terminated: true, error: this._error }

    let notify!: (error?: Error) => void
    const terminated = new Promise<Terminated>((resolve) => {
      notify = (error) => resolve({ terminated: true, error })
      this._waiters.add(notify)
    })
    const received: Promise<WaitResult<T>> = promise.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )

    try {
      const result = await Promise.race([received, terminated])
      if (this._terminated) {
        return { terminated: true, error: this._error }
      }
      return result
    } finally {
      this._waiters.delete(notify)
    }
  }

  public next<T>(
    iterator: AsyncIterator<T>,
  ): Promise<Received<T> | Terminated> {
    return this.wait(iterator.next())
  }
}

export function sourceIterator<T>(source: Source<T>): AsyncIterator<T> {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]()
  const iterator = source[Symbol.iterator]()
  return { next: async () => iterator.next() }
}
// closeIterator asks an abandoned iterator to release its upstream resources.
// Async generators may wait for an active next call before running return;
// rejection is observed here so cleanup cannot create an unhandled promise.
export function closeIterator<T>(iterator: AsyncIterator<T>): void {
  if (!iterator.return) return
  void Promise.resolve(iterator.return()).catch(() => undefined)
}
