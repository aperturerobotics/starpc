import { HandleStreamFunc } from './stream.js'
import { ValueCtr } from './value-ctr.js'

// HandleStreamCtr contains an OpenStream func which can be awaited.
export class HandleStreamCtr extends ValueCtr<HandleStreamFunc> {
  constructor(handleStreamFn?: HandleStreamFunc) {
    super(handleStreamFn)
  }

  // handleStreamFunc returns an HandleStreamFunc which waits for the underlying HandleStreamFunc.
  get handleStreamFunc(): HandleStreamFunc {
    return async (stream) => {
      let handleFn = this.value
      if (!handleFn) {
        handleFn = await this.wait()
      }
      return handleFn(stream)
    }
  }
}
