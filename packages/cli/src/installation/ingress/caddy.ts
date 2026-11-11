import { INSTALLER_SPEC } from '../spec'

const { suffixes, ports, web, admin, router, credentialDirectory } = INSTALLER_SPEC.ingress

const notFound = {
  handle: [{ handler: 'static_response', status_code: 404 }],
  terminal: true,
}

function proxy(host: string, upstream: string) {
  return {
    match: [{ host: [host] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: upstream }] }],
    terminal: true,
  }
}

function redirect(host: string) {
  return {
    match: [{ host: [host, `*.${host}`] }],
    handle: [
      {
        handler: 'static_response',
        status_code: 308,
        headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
      },
    ],
    terminal: true,
  }
}

function listener(listen: string, routes: readonly object[], extra: object = {}) {
  return { listen: [listen], automatic_https: { disable: true }, routes, ...extra }
}

/**
 * Concrete native Caddy JSON with no placeholders beyond the request ones.
 * Public listeners live in servers of their own, so the Worker-managed route
 * array of the loopback router server and its fallback id never move. With
 * automatic HTTPS disabled, the explicit connection policy is what enables TLS
 * for the delivered certificate. Only TCP is published, so HTTP/3 stays off.
 * Capsule hosts are exactly one label beneath the host, and anything else is
 * answered with 404 rather than reaching Web.
 */
export function caddyConfig(host: string, tls: boolean): string {
  const routes = [proxy(host, web), proxy(`*.${host}`, router.listen), notFound]
  const servers = tls
    ? {
        public: listener(`:${ports.https}`, routes, { protocols: ['h1', 'h2'], tls_connection_policies: [{}] }),
        redirect: listener(`:${ports.http}`, [redirect(host), notFound]),
      }
    : { public: listener(`:${ports.http}`, routes) }
  const config = {
    admin: { listen: admin },
    apps: {
      ...(tls
        ? {
            tls: {
              certificates: {
                load_files: [
                  {
                    certificate: `${credentialDirectory}/${suffixes.certificate}`,
                    key: `${credentialDirectory}/${suffixes.key}`,
                  },
                ],
              },
            },
          }
        : {}),
      http: {
        servers: {
          [router.server]: listener(router.listen, [{ '@id': router.fallbackId, ...notFound }], {
            trusted_proxies: { source: 'static', ranges: ['127.0.0.1/32'] },
            trusted_proxies_strict: 1,
          }),
          ...servers,
        },
      },
    },
  }
  return `${JSON.stringify(config, null, 2)}\n`
}
