import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface PackageManifest {
  name: string
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`response has no ${field}`)
  }
  const fieldValue = (value as Record<string, unknown>)[field]
  if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
    throw new Error(`response has no ${field}`)
  }
  return fieldValue
}

export async function githubIdentityToken(): Promise<string> {
  if (process.env.NPM_ID_TOKEN) {
    return process.env.NPM_ID_TOKEN
  }

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!requestUrl || !requestToken) {
    throw new Error('GitHub OIDC requires id-token: write permission')
  }

  const url = new URL(requestUrl)
  url.searchParams.append('audience', 'npm:registry.npmjs.org')
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${requestToken}`,
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub OIDC request failed with HTTP ${response.status}`)
  }
  return stringField(await response.json(), 'value')
}

export async function npmPublishToken(
  packageName: string,
  identityToken: string,
): Promise<string> {
  const escapedName = encodeURIComponent(packageName)
  const response = await fetch(
    `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${escapedName}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${identityToken}`,
      },
    },
  )
  if (!response.ok) {
    throw new Error(`npm OIDC exchange failed with HTTP ${response.status}`)
  }
  return stringField(await response.json(), 'token')
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    readFileSync('package.json', 'utf8'),
  ) as PackageManifest
  const identityToken = await githubIdentityToken()
  const publishToken = await npmPublishToken(manifest.name, identityToken)
  execFileSync('bun', ['publish', '--ignore-scripts'], {
    stdio: 'inherit',
    env: { ...process.env, NPM_CONFIG_TOKEN: publishToken },
  })
}

if (import.meta.main) {
  await main()
}
