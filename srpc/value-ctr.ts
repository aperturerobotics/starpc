// ValueCtr contains a value that can be set asynchronously.
export class ValueCtr<T> {
  // _value contains the current value.
  private _value: T | undefined
  // _waiters contains the list of waiters.
  // called when the value is set to any value other than undefined.
  private _waiters: ((fn: T) => void)[]

  constructor(initialValue?: T) {
    this._value = initialValue || undefined
    this._waiters = []
  }

  // value returns the current value.
  get value(): T | undefined {
    return this._value
  }

  // wait waits for the value to not be undefined.
  public async wait(): Promise<T> {
    const currVal = this._value
    if (currVal !== undefined) {
      return currVal
    }
    return new Promise<T>((resolve) => {
      this.waitWithCb((val: T) => {
        resolve(val)
      })
    })
  }

  // waitWithCb adds a callback to be called when the value is not undefined.
  public waitWithCb(cb: (val: T) => void) {
    if (cb) {
      this._waiters.push(cb)
    }
  }

  // set sets the value and calls the callbacks.
  public set(val: T | undefined) {
    this._value = val
    if (val === undefined) {
      return
    }
    const waiters = this._waiters
    if (waiters.length === 0) {
      return
    }
    this._waiters = []
    for (const waiter of waiters) {
      waiter(val)
    }
  }
}
