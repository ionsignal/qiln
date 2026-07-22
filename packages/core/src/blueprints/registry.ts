import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { z, type ZodError } from 'zod'
import { GlobalError, GlobalErrorCode } from '../errors'
import { digestCanonicalJsonValue } from '../digest/canonical'
import {
  CapsuleBlueprintDigestSchema,
  CapsuleBlueprintManifestSchema,
  type CapsuleBlueprintDigest,
  type CapsuleBlueprintManifest,
  type CapsuleBlueprintManifestItem,
} from '../schemas/blueprint/catalog'
import {
  CapsuleBlueprintPinSchema,
  CapsuleBlueprintSchema,
  type CapsuleBlueprint,
  type CapsuleBlueprintPin,
} from '../schemas/blueprint/schema'

const DEFAULT_LOGGER_PREFIX = '[CapsuleBlueprintRegistry]'

export interface CapsuleBlueprintRegistryOptions {
  loggerPrefix?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

function detailsFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }
  if (isRecord(value)) {
    return value
  }
  if (value === undefined || value === null) {
    return undefined
  }
  return {
    value,
  }
}

function validationDetails(error: ZodError): Record<string, unknown> {
  return {
    validation: z.treeifyError(error),
  }
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

/**
 * Recursively freezes validated JSON-compatible registry output.
 *
 * Blueprint values contain only plain objects, arrays, and JSON primitives
 * after Zod validation. Freezing them prevents callers from mutating reviewed
 * definitions or generated pins after their digest has been verified.
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item)
    }
    Object.freeze(value)
    return value
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function digestCanonicalValue(value: unknown): CapsuleBlueprintDigest {
  const digest = digestCanonicalJsonValue(value, {
    context: 'capsule blueprint digest input',
  })
  const parsedDigest = CapsuleBlueprintDigestSchema.safeParse(digest)
  if (!parsedDigest.success) {
    throw new GlobalError('Generated capsule blueprint digest failed validation.', GlobalErrorCode.INTERNAL_ERROR, {
      digest,
      ...validationDetails(parsedDigest.error),
    })
  }
  return parsedDigest.data
}

/**
 * Server-only registry for loading validated capsule blueprint YAML files.
 *
 * This class intentionally lives in @qiln/core/server because it owns shared
 * capsule blueprint contract behavior while depending on Node filesystem APIs.
 * Do not export it from @qiln/core/client.
 */
export class CapsuleBlueprintRegistry {
  private cache = new Map<string, CapsuleBlueprint>()
  private readonly loggerPrefix: string

  constructor(options: CapsuleBlueprintRegistryOptions = {}) {
    this.loggerPrefix = options.loggerPrefix ?? DEFAULT_LOGGER_PREFIX
  }

  /**
   * Loads all YAML capsule blueprints from a directory into memory.
   *
   * The cache is replaced only after the entire directory loads successfully,
   * so a failed reload cannot leave a partially loaded registry.
   */
  public async load(directory: string): Promise<void> {
    const resolvedDirectory = path.resolve(directory)
    const nextCache = new Map<string, CapsuleBlueprint>()
    try {
      const entries = await fs.readdir(resolvedDirectory, {
        withFileTypes: true,
      })
      const yamlFiles = entries
        .filter(dirent => dirent.isFile() && (dirent.name.endsWith('.yaml') || dirent.name.endsWith('.yml')))
        .map(dirent => dirent.name)
        .sort((left, right) => left.localeCompare(right))
      for (const file of yamlFiles) {
        const filePath = path.join(resolvedDirectory, file)
        const content = await fs.readFile(filePath, 'utf-8')
        const parsedYaml = this.parseBlueprintYaml(content, file, filePath)
        const result = CapsuleBlueprintSchema.safeParse(parsedYaml)
        if (!result.success) {
          throw new GlobalError(
            `Malformed Capsule Blueprint: ${file}. Validation failed.`,
            GlobalErrorCode.BAD_REQUEST,
            {
              file,
              path: filePath,
              ...validationDetails(result.error),
            },
          )
        }
        const blueprint = deepFreeze(result.data)
        if (nextCache.has(blueprint.name)) {
          throw new GlobalError(`Duplicate capsule blueprint '${blueprint.name}'.`, GlobalErrorCode.CONFLICT, {
            name: blueprint.name,
            file,
            path: filePath,
            directory: resolvedDirectory,
          })
        }
        console.log(`${this.loggerPrefix} Loaded capsule blueprint '${blueprint.name}' from ${file}.`)
        nextCache.set(blueprint.name, blueprint)
      }
      this.cache = nextCache
      console.log(`${this.loggerPrefix} Successfully loaded ${this.cache.size} capsule blueprints.`)
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        const notFound = new GlobalError(
          `Capsule blueprint directory not found at '${resolvedDirectory}'.`,
          GlobalErrorCode.NOT_FOUND,
          {
            directory: resolvedDirectory,
            error: detailsFromUnknown(error),
          },
        )
        console.error(`${this.loggerPrefix} FATAL: ${notFound.message}`)
        throw notFound
      }
      if (error instanceof GlobalError) {
        console.error(`${this.loggerPrefix} FATAL: Failed to load capsule blueprints from ${resolvedDirectory}`, error)
        throw error
      }
      console.error(`${this.loggerPrefix} FATAL: Failed to load capsule blueprints from ${resolvedDirectory}`, error)
      throw new GlobalError(
        `Failed to load capsule blueprints from '${resolvedDirectory}'.`,
        GlobalErrorCode.INTERNAL_ERROR,
        {
          directory: resolvedDirectory,
          error: detailsFromUnknown(error),
        },
      )
    }
  }

  /**
   * Resolves a caller-reviewed blueprint digest to an immutable durable
   * blueprint pin.
   */
  public pin(name: string, digest: string): CapsuleBlueprintPin {
    const parsedDigest = CapsuleBlueprintDigestSchema.safeParse(digest)
    if (!parsedDigest.success) {
      throw new GlobalError(`Invalid digest for capsule blueprint '${name}'.`, GlobalErrorCode.BAD_REQUEST, {
        name,
        ...validationDetails(parsedDigest.error),
      })
    }
    const blueprint = this.get(name)
    if (!blueprint) {
      throw new GlobalError(`Capsule blueprint '${name}' not found.`, GlobalErrorCode.NOT_FOUND, {
        name,
      })
    }
    const actualDigest = digestCanonicalValue(blueprint)
    if (actualDigest !== parsedDigest.data) {
      throw new GlobalError(
        `Capsule blueprint '${name}' digest does not match the reviewed manifest item.`,
        GlobalErrorCode.CONFLICT,
        {
          name,
          expectedDigest: parsedDigest.data,
          actualDigest,
        },
      )
    }
    const pin = {
      name: blueprint.name,
      digest: actualDigest,
      blueprint,
    }
    const parsedPin = CapsuleBlueprintPinSchema.safeParse(pin)
    if (!parsedPin.success) {
      throw new GlobalError(
        'Generated capsule blueprint pin failed validation.',
        GlobalErrorCode.INTERNAL_ERROR,
        validationDetails(parsedPin.error),
      )
    }
    return deepFreeze(parsedPin.data)
  }

  public get(name: string): CapsuleBlueprint | undefined {
    return this.cache.get(name)
  }

  public list(): CapsuleBlueprint[] {
    return deepFreeze(Array.from(this.cache.values()))
  }

  /**
   * Returns an immutable client-safe manifest of provisionable capsule
   * blueprints.
   */
  public manifest(): CapsuleBlueprintManifest {
    const blueprints = Array.from(this.cache.values())
      .sort((left, right) => compareStableString(left.name, right.name))
      .map<CapsuleBlueprintManifestItem>(blueprint => ({
        name: blueprint.name,
        displayName: blueprint.display_name,
        description: blueprint.description,
        digest: digestCanonicalValue(blueprint),
      }))
    const catalogDigest = digestCanonicalValue({
      schemaVersion: 1,
      blueprints,
    })
    const manifest = {
      schemaVersion: 1,
      catalogDigest,
      blueprints,
    }
    const parsed = CapsuleBlueprintManifestSchema.safeParse(manifest)
    if (!parsed.success) {
      throw new GlobalError(
        'Generated capsule blueprint manifest failed validation.',
        GlobalErrorCode.INTERNAL_ERROR,
        validationDetails(parsed.error),
      )
    }
    return deepFreeze(parsed.data)
  }

  private parseBlueprintYaml(content: string, file: string, filePath: string): unknown {
    try {
      return parse(content)
    } catch (error: unknown) {
      throw new GlobalError(`Malformed Capsule Blueprint YAML: ${file}.`, GlobalErrorCode.BAD_REQUEST, {
        file,
        path: filePath,
        error: detailsFromUnknown(error),
      })
    }
  }
}
