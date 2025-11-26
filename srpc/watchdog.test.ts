import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Watchdog } from './watchdog.js'

describe('Watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should call expired callback after timeout', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    expect(callback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should reset timeout when fed', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    vi.advanceTimersByTime(500)
    expect(callback).not.toHaveBeenCalled()

    watchdog.feed()
    vi.advanceTimersByTime(500)
    expect(callback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should not expire when paused', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    vi.advanceTimersByTime(500)
    expect(callback).not.toHaveBeenCalled()

    watchdog.pause()
    expect(watchdog.isPaused).toBe(true)

    vi.advanceTimersByTime(2000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('should resume from where it left off', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    vi.advanceTimersByTime(600)
    expect(callback).not.toHaveBeenCalled()

    watchdog.pause()
    vi.advanceTimersByTime(5000)
    expect(callback).not.toHaveBeenCalled()

    watchdog.resume()
    expect(watchdog.isPaused).toBe(false)

    vi.advanceTimersByTime(400)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should handle multiple pause/resume cycles', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    vi.advanceTimersByTime(300)

    watchdog.pause()
    vi.advanceTimersByTime(1000)

    watchdog.resume()
    vi.advanceTimersByTime(300)

    watchdog.pause()
    vi.advanceTimersByTime(1000)

    watchdog.resume()
    vi.advanceTimersByTime(400)

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should be idempotent when pausing already paused watchdog', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    watchdog.pause()
    watchdog.pause()
    watchdog.pause()

    expect(watchdog.isPaused).toBe(true)

    vi.advanceTimersByTime(2000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('should be idempotent when resuming already running watchdog', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    watchdog.resume()
    watchdog.resume()

    expect(watchdog.isPaused).toBe(false)

    vi.advanceTimersByTime(1000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should clear watchdog and prevent callback', () => {
    const callback = vi.fn()
    const watchdog = new Watchdog(1000, callback)

    watchdog.feed()
    vi.advanceTimersByTime(500)

    watchdog.clear()
    vi.advanceTimersByTime(1000)

    expect(callback).not.toHaveBeenCalled()
  })
})
