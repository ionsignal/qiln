import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'
import { AppDefinitionSchema, type AppDefinition } from '../schemas/definitions'
import { IncusError } from '../errors'

export class DefinitionRegistryService {
  private readonly cache = new Map<string, AppDefinition>()

  /**
   * Loads, parses, and strictly validates all YAML definitions in the given directory.
   * Fail-fast: Throws a synchronous/unhandled error if any file is malformed, halting boot.
   */
  public async load(directory: string): Promise<void> {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      const yamlFiles = entries
        .filter(dirent => dirent.isFile() && (dirent.name.endsWith('.yaml') || dirent.name.endsWith('.yml')))
        .map(dirent => dirent.name)
      for (const file of yamlFiles) {
        const filePath = path.join(directory, file)
        const content = await fs.readFile(filePath, 'utf-8')
        const parsedYaml = yaml.parse(content)
        const result = AppDefinitionSchema.safeParse(parsedYaml)
        if (!result.success) {
          throw new IncusError(`Malformed App Blueprint: ${file}. Validation failed.`, 'VALIDATION_ERROR', result.error.format())
        }
        const definition = result.data
        //
        // [DEBUG] Log the successfully parsed and validated YAML object
        console.log(`[QilnEngine Registry] Successfully parsed ${file}:\n`, JSON.stringify(definition, null, 2))
        //
        this.cache.set(definition.name, definition)
      }
      console.log(`[QilnEngine Registry] Successfully loaded ${this.cache.size} app definitions.`)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`[QilnEngine Registry] FATAL: Blueprint directory not found at '${directory}'. Please ensure the catalog exists.`)
        throw error
      }
      console.error(`[QilnEngine Registry] FATAL: Failed to load app definitions from ${directory}`, error)
      throw error // Ensure the Fastify boot sequence halts
    }
  }

  /**
   * Retrieves a validated definition by its name alias.
   */
  public get(name: string): AppDefinition | undefined {
    return this.cache.get(name)
  }

  /**
   * Returns all loaded definitions.
   */
  public getAll(): AppDefinition[] {
    return Array.from(this.cache.values())
  }
}
