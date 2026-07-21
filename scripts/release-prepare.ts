// release-prepare bumps the version metadata on a dedicated release branch,
// commits it signed, pushes the branch, and opens a pull request. Preparation
// never tags: the metadata commit becomes a release only after that pull request
// is approved, merged, and green. release-verify-commit then consumes the exact
// reviewed commit before any tag or publish, so no unreviewed release commit is
// ever created on the protected branch.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface PackageManifest {
  version: string
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

const branchName = execFileSync('git', ['branch', '--show-current'], {
  encoding: 'utf8',
}).trim()
if (branchName !== 'master') {
  throw new Error(`release preparation requires master, found ${branchName}`)
}
if (
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    .length !== 0
) {
  throw new Error('release preparation requires a clean worktree')
}

const bump = process.argv[2] === 'minor' ? 'minor' : 'patch'
run('bun', ['scripts/release-version.ts', bump])

const manifest = JSON.parse(
  readFileSync('package.json', 'utf8'),
) as PackageManifest
const version = manifest.version
const branch = `release/v${version}`

run('git', ['checkout', '-b', branch])
run('git', ['add', 'package.json', 'Cargo.toml'])
run('git', ['commit', '-s', '-m', `release: v${version}`])
run('git', ['push', '-u', 'origin', branch])
run('gh', [
  'pr',
  'create',
  '--base',
  'master',
  '--head',
  branch,
  '--title',
  `release: v${version}`,
  '--body',
  `Release metadata for v${version}. Tag and publish consume this exact commit only after approval, merge, and green required CI (see scripts/release-verify-commit.ts and the release workflow verify job).`,
])

console.log(
  `Opened release PR for v${version}. After approval and merge, run "bun run release:tag" on the merged commit.`,
)
