import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { z, type ZodError } from 'zod'
import { GlobalError, GlobalErrorCode } from '../errors'
import { CapsuleBlueprintSchema, type CapsuleBlueprint } from '../schemas'

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
   * The cache is replaced only after the entire directory loads successfully, so
   * a failed reload cannot leave callers with a partially loaded registry.
   */
  public async load(directory: string): Promise<void> {
    const resolvedDirectory = path.resolve(directory)
    const nextCache = new Map<string, CapsuleBlueprint>()
    try {
      const entries = await fs.readdir(resolvedDirectory, { withFileTypes: true })
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
          throw new GlobalError(`Malformed Capsule Blueprint: ${file}. Validation failed.`, GlobalErrorCode.BAD_REQUEST, {
            file,
            path: filePath,
            ...validationDetails(result.error),
          })
        }
        const blueprint = result.data
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
        const notFound = new GlobalError(`Capsule blueprint directory not found at '${resolvedDirectory}'.`, GlobalErrorCode.NOT_FOUND, {
          directory: resolvedDirectory,
          error: detailsFromUnknown(error),
        })
        console.error(`${this.loggerPrefix} FATAL: ${notFound.message}`)
        throw notFound
      }
      if (error instanceof GlobalError) {
        console.error(`${this.loggerPrefix} FATAL: Failed to load capsule blueprints from ${resolvedDirectory}`, error)
        throw error
      }
      console.error(`${this.loggerPrefix} FATAL: Failed to load capsule blueprints from ${resolvedDirectory}`, error)
      throw new GlobalError(`Failed to load capsule blueprints from '${resolvedDirectory}'.`, GlobalErrorCode.INTERNAL_ERROR, {
        directory: resolvedDirectory,
        error: detailsFromUnknown(error),
      })
    }
  }

  /**
   * Retrieves a validated capsule blueprint by name.
   */
  public get(name: string): CapsuleBlueprint | undefined {
    return this.cache.get(name)
  }

  /**
   * Lists all loaded capsule blueprints.
   */
  public list(): CapsuleBlueprint[] {
    return Array.from(this.cache.values())
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
