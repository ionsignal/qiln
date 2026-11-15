import { createHash, createHmac } from 'node:crypto'
import { AWS_SPEC } from '../spec'
import type { Credentials } from '../child/context'

const { audience } = AWS_SPEC.domain

const HOST = 'sts.us-east-1.amazonaws.com'
const REGION = 'us-east-1'
const SERVICE = 'sts'
const BODY = 'Action=GetCallerIdentity&Version=2011-06-15'

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

export function requestDigest(method: string, path: string, body: string): string {
  return sha256(`${method}\n${path}\n${sha256(body)}`)
}

/**
 * Signs the one fixed GetCallerIdentity request that the service replays to STS
 * and returns it as the Qiln-Proof header value. The proof carries the session
 * token, so it is built in memory, sent once to the pinned origin, and never
 * written or logged. Only headers the service rebuilds are signed. This is the
 * one deliberate exception to keeping AWS operator credentials local: the
 * session token alone signs nothing, and the signature is bound to this fixed
 * request, a single-use nonce, and the service audience. The service must never
 * log or persist the header.
 */
export function sign(credentials: Credentials, nonce: string, method: string, path: string, body: string): string {
  const { accessKeyId, secretAccessKey } = credentials
  const token = credentials.sessionToken || undefined
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const request = requestDigest(method, path, body)
  const headers: Record<string, string> = {
    host: HOST,
    'x-amz-date': amzDate,
    ...(token === undefined ? {} : { 'x-amz-security-token': token }),
    'x-qiln-audience': audience,
    'x-qiln-nonce': nonce,
    'x-qiln-request': request,
  }
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const scope = `${day}/${REGION}/${SERVICE}/aws4_request`
  const canonicalRequest = [
    'POST',
    '/',
    '',
    names.map(name => `${name}:${headers[name]}\n`).join(''),
    signedHeaders,
    sha256(BODY),
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const key = [day, REGION, SERVICE, 'aws4_request'].reduce<string | Buffer>(
    (secret, part) => hmac(secret, part),
    `AWS4${secretAccessKey}`,
  )
  const signature = hmac(key, stringToSign).toString('hex')
  const proof = {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    securityToken: token,
    nonce,
    audience,
    request,
  }
  return Buffer.from(JSON.stringify(proof)).toString('base64url')
}
