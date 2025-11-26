// Watchdog must be fed every timeoutDuration or it will call the expired callback.
// NOTE: Browsers will throttle setTimeout in background tabs.
export class Watchdog {
  private timeoutDuration: number
  private expiredCallback: () => void
  private timerId: NodeJS.Timeout | null = null
  private lastFeedTimestamp: number | null = null
  // paused indicates the watchdog is paused and will not expire.
  private paused = false
  // pausedTimestamp records when the watchdog was paused.
  private pausedTimestamp: number | null = null

  /**
   * Constructs a Watchdog instance.
   * The Watchdog will not start ticking until feed() is called.
   * @param timeoutDuration The duration in milliseconds after which the watchdog should expire if not fed.
   * @param expiredCallback The callback function to be called when the watchdog expires.
   */
  constructor(timeoutDuration: number, expiredCallback: () => void) {
    this.timeoutDuration = timeoutDuration
    this.expiredCallback = expiredCallback
  }

  /**
   * Returns whether the watchdog is currently paused.
   */
  public get isPaused(): boolean {
    return this.paused
  }

  /**
   * Pauses the watchdog, preventing it from expiring until resumed.
   * The time spent paused does not count towards the timeout.
   */
  public pause(): void {
    if (this.paused) {
      return
    }
    this.paused = true
    this.pausedTimestamp = Date.now()
    if (this.timerId != null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
  }

  /**
   * Resumes the watchdog after being paused.
   * The timeout continues from where it left off, not counting the paused duration.
   */
  public resume(): void {
    if (!this.paused) {
      return
    }
    this.paused = false
    // Adjust lastFeedTimestamp to exclude paused duration.
    if (this.lastFeedTimestamp != null && this.pausedTimestamp != null) {
      const pausedDuration = Date.now() - this.pausedTimestamp
      this.lastFeedTimestamp += pausedDuration
    }
    this.pausedTimestamp = null
    // Reschedule the watchdog if it was active.
    if (this.lastFeedTimestamp != null) {
      const elapsed = Date.now() - this.lastFeedTimestamp
      const remaining = Math.max(0, this.timeoutDuration - elapsed)
      this.scheduleTickWatchdog(remaining)
    }
  }

  /**
   * Feeds the watchdog, preventing it from expiring.
   * This resets the timeout and reschedules the next tick.
   */
  public feed(): void {
    this.lastFeedTimestamp = Date.now()
    this.scheduleTickWatchdog(this.timeoutDuration)
  }

  /**
   * Clears the current timeout, effectively stopping the watchdog.
   * This prevents the expired callback from being called until the watchdog is fed again.
   */
  public clear(): void {
    if (this.timerId != null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
    this.lastFeedTimestamp = null
  }

  /**
   * Schedules the next tick of the watchdog.
   * This method calculates the delay for the next tick based on the last feed time
   * and schedules a call to tickWatchdog after that delay.
   */
  private scheduleTickWatchdog(delay: number): void {
    if (this.timerId != null) {
      clearTimeout(this.timerId)
    }
    this.timerId = setTimeout(() => this.tickWatchdog(), delay)
  }

  /**
   * Handler for the watchdog tick.
   * Checks if the time since the last feed is greater than the timeout duration.
   * If so, it calls the expired callback. Otherwise, it reschedules the tick.
   */
  private tickWatchdog(): void {
    this.timerId = null
    if (this.paused) {
      return
    }
    if (this.lastFeedTimestamp == null) {
      this.expiredCallback()
      return
    }
    const elapsedSinceLastFeed = Date.now() - this.lastFeedTimestamp
    if (elapsedSinceLastFeed >= this.timeoutDuration) {
      this.expiredCallback()
    } else {
      this.scheduleTickWatchdog(this.timeoutDuration - elapsedSinceLastFeed)
    }
  }
}
