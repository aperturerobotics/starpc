import { execFileSync } from 'node:child_process'

interface PackageManifest {
  version: string
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

function gitShow(commit: string, path: string): string {
  return execFileSync('git', ['show', `${commit}:${path}`], {
    encoding: 'utf8',
  })
}

export function releaseVersionFromCommit(
  commit: string,
  readCommitFile: (commit: string, path: string) => string = gitShow,
): string {
  const manifest = JSON.parse(
    readCommitFile(commit, 'package.json'),
  ) as PackageManifest
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`unsupported package version: ${manifest.version}`)
  }

  const cargo = readCommitFile(commit, 'Cargo.toml')
  const cargoVersion = /^version = "([^"]+)"$/m.exec(cargo)?.[1]
  if (cargoVersion !== manifest.version) {
    throw new Error(
      `package version ${manifest.version} does not match Cargo version ${cargoVersion ?? '<missing>'}`,
    )
  }

  return manifest.version
}

function main(): void {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  run('bun', ['scripts/release-verify-commit.ts', commit])

  const tag = `v${releaseVersionFromCommit(commit)}`
  run('git', ['tag', tag, commit])
  run('git', ['push', 'origin', tag])
}

if (import.meta.main) {
  main()
}
