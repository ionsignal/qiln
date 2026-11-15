import { X509Certificate, type KeyObject } from 'node:crypto'

const MAXIMUM_CERTIFICATES = 4
const BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g

/**
 * A certificate chain that passed `readChain`, leaf first. The validity window
 * is read from the leaf, so it is never stored beside the chain.
 */
export interface Chain {
  leaf: X509Certificate
  notBefore: Date
  notAfter: Date
}

/**
 * The validity window that the service reported with its chain.
 */
export interface Window {
  notBefore: string
  notAfter: string
}

function certificatesOf(text: string): X509Certificate[] | null {
  const blocks = text.match(BLOCK)
  if (blocks === null || blocks.length > MAXIMUM_CERTIFICATES || text.replace(BLOCK, '').trim() !== '') {
    return null
  }
  try {
    return blocks.map(block => new X509Certificate(block))
  } catch {
    return null
  }
}

// TODO(tls-chain-trust): Public trust validation is deferred to a future slice.
// Single certificates skip signature checks; chains are not validated to a
// public trust root or checked for CA constraints.
function signedInOrder(certificates: readonly X509Certificate[]): boolean {
  return certificates.every((certificate, index) => {
    const issuer = certificates.at(index + 1)
    return issuer === undefined || certificate.verify(issuer.publicKey)
  })
}

/**
 * Judges a PEM chain against the retained key and the allocated names: a
 * bounded number of certificates and nothing else in the text, a leaf that
 * belongs to the key, exactly the apex and wildcard names of `base`, and every
 * certificate signed by the next. This is not path validation to a trust root,
 * and it ignores the validity window, so a retained chain stays readable after
 * it expires. Null means the chain is not acceptable, and the caller chooses
 * the diagnostic.
 */
export function readChain(text: string, key: KeyObject, base: string): Chain | null {
  const certificates = certificatesOf(text)
  const leaf = certificates?.at(0)
  if (certificates === null || leaf === undefined) {
    return null
  }
  const names = [`DNS:${base}`, `DNS:*.${base}`]
  const reported = (leaf.subjectAltName ?? '').split(', ')
  if (
    !leaf.checkPrivateKey(key) ||
    reported.length !== names.length ||
    !names.every(name => reported.includes(name)) ||
    !signedInOrder(certificates)
  ) {
    return null
  }
  return { leaf, notBefore: leaf.validFromDate, notAfter: leaf.validToDate }
}

/**
 * Whether the window reported with a chain is the one its leaf carries.
 */
export function matches({ notBefore, notAfter }: Chain, window: Window): boolean {
  return notBefore.getTime() === Date.parse(window.notBefore) && notAfter.getTime() === Date.parse(window.notAfter)
}

/**
 * The service returns a stored certificate for the same key until two thirds of
 * its lifetime have passed, so renewal is only meaningful from this point.
 */
export function renewAt({ notBefore, notAfter }: Chain): Date {
  return new Date(notBefore.getTime() + Math.floor(((notAfter.getTime() - notBefore.getTime()) * 2) / 3))
}
