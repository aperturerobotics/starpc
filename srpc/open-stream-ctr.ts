import { OpenStreamFunc } from './stream.js'
import { ValueCtr } from './value-ctr.js'

// OpenStreamCtr contains an OpenStream func which can be awaited.
export class OpenStreamCtr extends ValueCtr<OpenStreamFunc> {
  constructor(openStreamFn?: OpenStreamFunc) {
    super(openStreamFn)
  }

  // openStreamFunc returns an OpenStreamFunc which waits for the underlying OpenStreamFunc.
  get openStreamFunc(): OpenStreamFunc {
    return async () => {
      let openFn = this.value
      if (!openFn) {
        openFn = await this.wait()
      }
      return openFn()
    }
  }
}
