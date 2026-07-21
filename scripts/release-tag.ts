import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface PackageManifest {
  version: string
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

const manifest = JSON.parse(
  readFileSync('package.json', 'utf8'),
) as PackageManifest
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`unsupported package version: ${manifest.version}`)
}

const cargo = readFileSync('Cargo.toml', 'utf8')
const cargoVersion = /^version = "([^"]+)"$/m.exec(cargo)?.[1]
if (cargoVersion !== manifest.version) {
  throw new Error(
    `package version ${manifest.version} does not match Cargo version ${cargoVersion ?? '<missing>'}`,
  )
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
run('bun', ['scripts/release-verify-commit.ts', commit])

const tag = `v${manifest.version}`
run('git', ['tag', tag, 'HEAD'])
run('git', ['push', 'origin', tag])
