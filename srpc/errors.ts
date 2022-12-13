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
