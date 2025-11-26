import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      starpc: path.resolve(__dirname, './srpc/index.ts'),
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/build/**',
      '**/.log/**',
      '**/.snowpack/**',
      '**/.DS_Store',
      '**/.env.local',
      '**/.env.development.local',
      '**/.env.test.local',
      '**/.env.production.local',
      '**/npm-debug.log*',
      '**/yarn-debug.log*',
      '**/yarn-error.log*',
      '**/.#*',
      '**/dist/**',
      '**/.*.swp',
      '**/.vs/**',
      '**/.vscode/**',
      '!**/.vscode/launch.json',
      '**/*.test',
      '**/vendor/**',
      '**/debug.test',
      '**/.aider*',
      '**/starpc-*.tgz',
      '**/.env',
    ],
  },
})
