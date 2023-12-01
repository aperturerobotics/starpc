import type { ComponentLogger, Logger } from '@libp2p/interface'

// https://github.com/libp2p/js-libp2p/issues/2276
// https://github.com/libp2p/js-libp2p/blob/bca8d6e689b47d85dda74082ed72e671139391de/packages/logger/src/index.ts#L86
// https://github.com/libp2p/js-libp2p/issues/2275
// https://github.com/ChainSafe/js-libp2p-yamux/issues/69
export function createDisabledLogger(namespace: string): Logger {
  const logger = (): void => {}
  logger.enabled = false
  logger.color = ''
  logger.diff = 0
  logger.log = (): void => {}
  logger.namespace = namespace
  logger.destroy = () => true
  logger.extend = () => logger
  logger.debug = logger
  logger.error = logger
  logger.trace = logger

  return logger
}

export function createDisabledComponentLogger(): ComponentLogger {
  return { forComponent: createDisabledLogger }
}
