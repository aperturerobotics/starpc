// TerminalKind is the terminal state of a held unary invocation.
export type TerminalKind =
  | 'committed'
  | 'canceled'
  | 'transportLost'
  | 'closed'
  | 'abandoned'

// ServerInvocation exposes the invocation signal and terminal wait.
export class ServerInvocation implements AbortSignal {
  public constructor(
    public readonly signal: AbortSignal,
    private readonly waitFn: (
      ownerSignal: AbortSignal,
    ) => Promise<TerminalKind>,
  ) {}

  public get aborted(): boolean {
    return this.signal.aborted
  }

  public get onabort() {
    return this.signal.onabort
  }

  public set onabort(value: typeof this.signal.onabort) {
    this.signal.onabort = value
  }

  public get reason() {
    return this.signal.reason
  }

  public throwIfAborted(): void {
    this.signal.throwIfAborted()
  }

  public addEventListener<K extends keyof AbortSignalEventMap>(
    type: K,
    listener: (this: AbortSignal, ev: AbortSignalEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void
  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void
  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.signal.addEventListener(type, listener, options)
  }

  public removeEventListener<K extends keyof AbortSignalEventMap>(
    type: K,
    listener: (this: AbortSignal, ev: AbortSignalEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void
  public removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void
  public removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.signal.removeEventListener(type, listener, options)
  }

  public dispatchEvent(event: Event): boolean {
    return this.signal.dispatchEvent(event)
  }

  // waitTerminal waits for a remote terminal or owner-signal cancellation.
  public waitTerminal(ownerSignal: AbortSignal): Promise<TerminalKind> {
    return this.waitFn(ownerSignal)
  }
}
