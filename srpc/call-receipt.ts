/// <reference lib="es2024.promise" />
import { ERR_RPC_ABORT } from './errors.js'
import { ClientRPC } from './client-rpc.js'

// ReceiptRpc exposes held unary calls without widening ProtoRpc.
export interface ReceiptRpc {
  requestWithReceipt(
    service: string,
    method: string,
    data: Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<HeldCall>
}

// HeldCall contains the first response and its held terminal receipt.
export interface HeldCall {
  readonly response: Uint8Array
  readonly receipt: CallReceipt
}

// CallReceipt holds a unary call until it is committed or aborted.
export class CallReceipt {
  #call: ClientRPC
  #iterator: AsyncIterator<Uint8Array>
  #terminalPromise: Promise<IteratorResult<Uint8Array>>
  #terminal?: 'committed' | 'aborted'
  #done: Promise<void>
  #requestCommitted = false
  #resolveDone!: () => void
  #rejectDone!: (reason?: unknown) => void

  public constructor(call: ClientRPC, iterator: AsyncIterator<Uint8Array>) {
    this.#call = call
    this.#iterator = iterator
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.#done = promise
    this.#resolveDone = resolve
    this.#rejectDone = reject
    this.#done.catch(() => undefined)
    this.#terminalPromise = this.#observeTerminal()
    this.#terminalPromise.catch(() => undefined)
  }

  async #observeTerminal(): Promise<IteratorResult<Uint8Array>> {
    try {
      const result = await this.#iterator.next()
      if (!result.done) {
        throw new Error('unexpected trailing response data')
      }
      const terminal = this.#call.getTerminalKind()
      if (
        terminal !== 'committed' ||
        !this.#requestCommitted ||
        this.#terminal !== 'committed'
      ) {
        throw new Error('receipt closed before commit')
      }
      return result
    } catch (err) {
      this.#rejectDone(err)
      const error =
        err instanceof Error ? err : new Error('receipt terminal failed')
      try {
        await this.#call.close(error)
      } catch {
        // The primary terminal error is already recorded on the receipt.
      }
      throw err
    }
  }

  // done resolves after committed close and rejects on terminal failure.
  public get done(): Promise<void> {
    return this.#done
  }

  // settled reports whether a terminal transition has been claimed.
  public get settled(): boolean {
    return this.#terminal !== undefined
  }

  // commit sends request completion and waits for server finalization.
  public async commit(): Promise<void> {
    if (this.#terminal === 'aborted') {
      throw new Error(ERR_RPC_ABORT)
    }
    if (this.#terminal === 'committed') {
      return this.#done
    }
    this.#terminal = 'committed'
    this.#requestCommitted = true
    try {
      await this.#call.writeCallData(undefined, true)
      await this.#terminalPromise
      await this.#call.close()
      this.#resolveDone()
    } catch (err) {
      await this.#call.close(
        err instanceof Error ? err : new Error('receipt commit failed'),
      )
      this.#rejectDone(err)
      throw err
    }
  }

  // abort sends request cancellation and never rejects.
  public async abort(reason?: Error): Promise<void> {
    if (this.#terminal !== undefined) {
      return
    }
    this.#terminal = 'aborted'
    let terminalError: unknown = reason
    try {
      await this.#call.writeCallCancel(true)
    } catch (err) {
      terminalError ??= err
    }
    try {
      await this.#call.close()
    } catch (err) {
      terminalError ??= err
    }
    this.#rejectDone(terminalError ?? new Error(ERR_RPC_ABORT))
  }

  // asyncDispose aborts a receipt that has not reached a terminal.
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.abort()
  }
}
