/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--lan`, `--port`, `--public-url`, `--trusted-host`,
 * `--no-open`, TLS) and its `--help` text, then provides the immutable values as
 * {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that service before
 * reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { isWildcardHost, type TlsConfig } from '@deepseek-ai/dsh-host-webserver'
import { parsePublicUrl } from './public-url.ts'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** Whether this invocation opens the default browser after startup. */
  openBrowser: boolean
  /**
   * Whether `--lan` chose the bind address, so the URL line also prints a QR
   * code. See [LAN access](../README.md#lan-access).
   */
  lan: boolean
  /** `--host`, or the address `--lan` resolved; absent when neither flag was given. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /**
   * `--public-url`, absent when not specified: the advertised HTTP(S) root.
   * See [public deployments](../README.md#public-deployments).
   */
  publicUrl?: string
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** Server certificate chain and unencrypted private key supplied together. */
  tls?: TlsConfig
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  lan?: string | true
  open: boolean
  port?: string
  publicUrl?: string
  trustedHost?: string[]
  tlsCert?: string
  tlsKey?: string
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind address: one concrete IPv4 or IPv6 literal of a local interface; wildcard addresses are rejected')
    .option('--lan [address]', 'serve this machine\'s private LAN IPv4 address (or the named local address) and print a QR code of the login URL; conflicts with --host')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--public-url <url>', 'advertise this HTTP(S) root in the printed, opened, runtime-context, and DSH_WEB_URL forms; grants no trust')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--tls-cert <file>', 'PEM server certificate chain; requires --tls-key')
    .option('--tls-key <file>', 'unencrypted PEM private key; requires --tls-cert')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 10.0.0.7          bind one local interface address
  dsh --profile web --lan                    serve the private LAN address and print a phone QR code
  dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping HTTPS proxy entry and admit its authority
  dsh --profile web --tls-cert ./server-chain.pem --tls-key ./server-key.pem
                                             serve HTTPS with an existing certificate and key
`)
}

/**
 * Interface names of virtual adapters (VM, container, VPN, and Apple peer-to-peer
 * links) whose private addresses a phone on the physical network cannot reach.
 */
const VIRTUAL_INTERFACE = /^(?:awdl|bridge|docker|llw|tap|tun|utun|vboxnet|veth|virbr|vmnet)/u

/**
 * Whether an IPv4 address lies in an RFC 1918 private range.
 * @param address - dotted-quad IPv4 address.
 * @returns true for 10/8, 172.16/12, and 192.168/16.
 */
function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Pick the bind address for a bare `--lan`: the single private IPv4 address
 * of a physical, non-internal interface.
 * @returns the address, or the usage error naming the candidates.
 */
function detectLanAddress(): { address: string } | { error: string } {
  const candidates = Object.entries(networkInterfaces()).flatMap(([iface, infos]) =>
    VIRTUAL_INTERFACE.test(iface)
      ? []
      : (infos ?? []).filter((info: NetworkInterfaceInfo) => info.family === 'IPv4' && !info.internal && isPrivateIpv4(info.address))
        .map(info => `${info.address} (${iface})`))
  const [only] = candidates
  if (candidates.length === 1 && only !== undefined) return { address: only.slice(0, only.indexOf(' ')) }
  return {
    error: candidates.length === 0
      ? 'error: --lan found no private IPv4 address on a physical interface; connect to a network or pass --lan <address>'
      : `error: --lan found several private IPv4 addresses: ${candidates.join(', ')}; pass --lan <address> to choose one`,
  }
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named. Invalid flags,
 * including an unpaired TLS certificate or key, are usage errors; rejection
 * and `--help` provide no service.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.lan !== undefined && options.host !== undefined) {
      program.error('error: --lan and --host both choose the bind address; pass only one')
    }
    let host = options.host
    let flag = '--host'
    if (options.lan === true) {
      const detected = detectLanAddress()
      if ('error' in detected) program.error(detected.error)
      else host = detected.address
    } else if (options.lan !== undefined) {
      host = options.lan
      flag = '--lan'
    }
    if (host !== undefined && isWildcardHost(host)) {
      program.error(`error: ${flag} ${host} is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead`)
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    let tls: TlsConfig | undefined
    if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
      tls = { certFile: options.tlsCert, keyFile: options.tlsKey }
    } else if (options.tlsCert !== undefined || options.tlsKey !== undefined) {
      program.error('error: --tls-cert and --tls-key must be supplied together')
    }
    if (options.publicUrl !== undefined) {
      try {
        parsePublicUrl(options.publicUrl, '--public-url')
      } catch (error) {
        program.error(`error: ${(error as Error).message}`)
      }
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      lan: options.lan !== undefined,
      ...host !== undefined && { host },
      ...options.port !== undefined && { port: Number(options.port) },
      ...options.publicUrl !== undefined && { publicUrl: options.publicUrl },
      ...tls !== undefined && { tls },
      trustedHosts: options.trustedHost ?? [],
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
