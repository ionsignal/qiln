import { INSTALLER_SPEC } from '../spec'

const { suffixes, ports, web, admin, router, credentialDirectory } = INSTALLER_SPEC.ingress

const notFound = {
  handle: [{ handler: 'static_response', status_code: 404 }],
  terminal: true,
}

function proxy(name: string, upstream: string) {
  return {
    match: [{ host: [name] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: upstream }] }],
    terminal: true,
  }
}

function redirect(name: string) {
  return {
    match: [{ host: [name, `*.${name}`] }],
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
 * for the delivered certificate. Without a certificate, TLS is terminated by an
 * edge in front of this host and only plain HTTP is served. Only TCP is
 * published, so HTTP/3 stays off. Capsule hosts are exactly one label beneath
 * the name, and anything else is answered with 404 rather than reaching Web.
 */
export function caddyConfig(name: string, certificate: boolean): string {
  const routes = [proxy(name, web), proxy(`*.${name}`, router.listen), notFound]
  const servers = certificate
    ? {
        public: listener(`:${ports.https}`, routes, { protocols: ['h1', 'h2'], tls_connection_policies: [{}] }),
        redirect: listener(`:${ports.http}`, [redirect(name), notFound]),
      }
    : { public: listener(`:${ports.http}`, routes) }
  const config = {
    admin: { listen: admin },
    apps: {
      ...(certificate
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
