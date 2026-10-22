/**
 * Real `dsh --profile web --lan` on this machine's network address: the QR
 * login line, the browser fence on /api and WebSocket upgrades, the token
 * exchange, and the refusal to serve the network without authentication.
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DSH_SOURCE_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TSX_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href

/** First non-internal IPv4 address of this host, or undefined on an offline runner. */
const NETWORK_ADDRESS = Object.values(networkInterfaces())
  .flatMap(infos => infos ?? [])
  .find(info => info.family === 'IPv4' && !info.internal)?.address

interface RunningWeb {
  readonly child: ChildProcess
  readonly output: () => string
  readonly exited: Promise<number | null>
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

function redact(output: string): string {
  return output.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
}

/** Reserve one free port on the network address, then release it for the CLI process. */
async function freePort(host: string): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

function cleanEnvironment(root: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  return {
    ...env,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_HOME: join(root, '.dsh'),
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    SSH_CONNECTION: '',
    SSH_TTY: '',
    TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
  }
}

/** Start the public source CLI with the given Web arguments. */
function startWeb(root: string, args: string[]): RunningWeb {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, DSH_SOURCE_BIN, '--profile', 'web', ...args], {
    cwd: root,
    env: cleanEnvironment(root),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = (chunk: Buffer | string): void => { output = `${output}${String(chunk)}`.slice(-100_000) }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const exited = new Promise<number | null>((resolve) => { child.once('exit', resolve) })
  return { child, output: () => output, exited }
}

/** Wait until the process output matches, failing on exit or timeout. */
async function waitForOutput(running: RunningWeb, pattern: RegExp): Promise<RegExpExecArray> {
  const deadline = Date.now() + 90_000
  for (;;) {
    const match = pattern.exec(running.output())
    if (match !== null) return match
    if (running.child.exitCode !== null) throw new Error(`dsh web exited (${String(running.child.exitCode)}):\n${redact(running.output())}`)
    if (Date.now() > deadline) throw new Error(`dsh web did not print ${String(pattern)}:\n${redact(running.output())}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function stopWeb(running: RunningWeb): Promise<void> {
  if (running.child.exitCode !== null) return
  running.child.kill('SIGTERM')
  const forced = setTimeout(() => { running.child.kill('SIGKILL') }, 10_000)
  forced.unref()
  await running.exited
  clearTimeout(forced)
}

/** Send one request to the network listener with explicit wire headers. */
function send(host: string, port: number, options: {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: host,
      port,
      path: options.path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    // An upgrade request that the server accepts would emit 'upgrade'; the
    // fence answers refused upgrades with an ordinary HTTP response.
    req.once('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 101, body: '' })
    })
    req.once('error', reject)
    req.end(options.body)
  })
}

/** POST one Remote envelope to /api/settings/describe. */
function describeSettings(host: string, port: number, headers: Record<string, string>): Promise<HttpResult> {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'web-lan', method: 'settings/describe', payload: { args: {} } })
  return send(host, port, {
    path: '/api/settings/describe',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
    body,
  })
}

/** WebSocket upgrade request for the Remote stream multiplexer. */
function upgradeHeaders(authority: string, extra: Record<string, string>): Record<string, string> {
  return {
    host: authority,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    ...extra,
  }
}

describe.skipIf(NETWORK_ADDRESS === undefined)('dsh --profile web --lan through the real CLI', () => {
  const address = NETWORK_ADDRESS ?? ''

  it('prints a QR login line and fences /api and WebSocket upgrades on the network address', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-lan-'))
    const port = await freePort(address)
    const authority = `${address}:${String(port)}`
    const running = startWeb(root, ['--lan', address, '--no-open', '--port', String(port)])
    try {
      const [, launchUrl = ''] = await waitForOutput(running, /dsh web: (http:\/\/\S+)\n/u)
      await waitForOutput(running, /anyone holding this link controls this machine\n[ \u2580\u2584\u2588]+\n/u)
      expect(running.output()).toContain(`dsh web: listening on ${address} over plain HTTP`)
      expect(new URL(launchUrl).origin).toBe(`http://${authority}`)

      // The page itself and /api both require the browser cookie.
      expect((await send(address, port, { path: '/', headers: { host: authority } })).status).toBe(401)
      expect(await describeSettings(address, port, { host: authority })).toEqual({ status: 401, body: 'unauthorized' })

      const exchange = await fetch(launchUrl, { redirect: 'manual' })
      expect(exchange.status).toBe(303)
      const setCookie = exchange.headers.get('set-cookie')
      if (setCookie === null) throw new Error('LAN token exchange omitted Set-Cookie')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      const cookie = setCookie.split(';', 1)[0]!

      expect((await describeSettings(address, port, { host: authority, cookie })).status).toBe(200)
      // A cookie does not admit a forged Host or a foreign page's Origin.
      expect((await describeSettings(address, port, { host: `evil.example:${String(port)}`, cookie })).status).toBe(403)
      expect((await describeSettings(address, port, { host: authority, cookie, origin: 'http://evil.example' })).status).toBe(403)

      const mux = '/api/remote.mux'
      expect((await send(address, port, { path: mux, headers: upgradeHeaders(authority, {}) })).status).toBe(401)
      expect((await send(address, port, { path: mux, headers: upgradeHeaders(authority, { cookie, origin: 'http://evil.example' }) })).status).toBe(403)
      expect((await send(address, port, { path: mux, headers: upgradeHeaders(`evil.example:${String(port)}`, { cookie }) })).status).toBe(403)
      expect((await send(address, port, { path: mux, headers: upgradeHeaders(authority, { cookie, origin: `http://${authority}` }) })).status).toBe(101)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(running.output())}`, { cause: error })
    } finally {
      await stopWeb(running)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to serve the network address when browser authentication is disabled', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-lan-noauth-'))
    const patch = join(root, 'no-connection.overlay.yml')
    await writeFile(patch, '- id: connection\n  disabled: true\n')
    const port = await freePort(address)
    const running = startWeb(root, ['--patch', patch, '--lan', address, '--no-open', '--port', String(port)])
    try {
      const code = await Promise.race([
        running.exited,
        new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 90_000)),
      ])
      expect(code, redact(running.output())).toBe(1)
      expect(running.output()).toContain(`web-app: refusing to serve ${address} without browser authentication`)
      expect(running.output()).not.toMatch(/dsh web: http/u)
    } finally {
      await stopWeb(running)
      await rm(root, { recursive: true, force: true })
    }
  })
})
