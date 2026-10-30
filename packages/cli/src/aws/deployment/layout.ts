import { z } from 'zod'
import { text } from '../primitives'
import { validSource } from './cidr'

/**
 * Leaf schemas shared by the deployment record and the host plan. This module
 * imports neither, which keeps the two from importing each other.
 */
const ZONE_ID = /^[a-z]+[0-9]-az[0-9]+$/
const ZONE_NAME = /^[a-z]+-[a-z]+-[0-9]+[a-z]$/
const INTERNET = '0.0.0.0/0'

const placementFields = {
  id: z.string().regex(ZONE_ID),
  name: z.string().regex(ZONE_NAME),
}

export const placementSchema = z.strictObject(placementFields)

export const zoneSchema = z.strictObject({
  ...placementFields,
  cidr: text,
})

export const ingressSchema = z.strictObject({
  port: z.int().min(1).max(65_535),
  cidr: z.string().refine(value => value === INTERNET || validSource(value), 'Expected an IPv4 network.'),
})

export const tagSchema = z.strictObject({
  Key: z.string().min(1).max(128),
  Value: z.string().max(256),
})

export const tagsSchema = z.array(tagSchema).max(50)

export type Placement = z.infer<typeof placementSchema>
export type Zone = z.infer<typeof zoneSchema>
export type Ingress = z.infer<typeof ingressSchema>
export type Tag = z.infer<typeof tagSchema>
