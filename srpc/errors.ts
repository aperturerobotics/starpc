// ERR_RPC_ABORT is returned if the RPC was aborted.
export const ERR_RPC_ABORT = 'ERR_RPC_ABORT'

// isAbortError checks if the error object is ERR_RPC_ABORT.
export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object') {
    return false
  }
  const message = (err as Error).message
  return message === ERR_RPC_ABORT
}

// ERR_STREAM_IDLE is returned if the stream idle timeout was exceeded.
export const ERR_STREAM_IDLE = 'ERR_STREAM_IDLE'

// isStreamIdleError checks if the error object is ERR_STREAM_IDLE.
export function isStreamIdleError(err: unknown): boolean {
  if (typeof err !== 'object') {
    return false
  }
  const message = (err as Error).message
  return message === ERR_STREAM_IDLE
}

// castToError casts an object to an Error.
// if err is a string, uses it as the message.
// if err is undefined, returns new Error(defaultMsg)
export function castToError(err: any, defaultMsg?: string): Error {
  defaultMsg = defaultMsg || 'error'
  if (!err) {
    return new Error(defaultMsg)
  }
  if (typeof err === 'string') {
    return new Error(err)
  }
  const asError = err as Error
  if (asError.message) {
    return asError
  }
  if (err.toString) {
    const errString = err.toString()
    if (errString) {
      return new Error(errString)
    }
  }
  return new Error(defaultMsg)
}
