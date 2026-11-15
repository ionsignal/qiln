import { z } from 'zod'

const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * A lowercase ASCII DNS name with at least two labels. IP literals and
 * uppercase input are refused rather than normalized.
 */
export const dnsName = z.string().max(253).regex(DNS_NAME)
