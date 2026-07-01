import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'
import { CapsuleBlueprintSchema, type CapsuleBlueprint } from '@qiln/core/server'
import { IncusError } from '../errors'

export class DefinitionRegistryService {
  private readonly cache = new Map<string, CapsuleBlueprint>()

  /**
   * Loads, parses, and strictly validates all YAML capsule blueprints in the given directory.
   * Fail-fast: Throws if any file is malformed, halting boot.
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
        const result = CapsuleBlueprintSchema.safeParse(parsedYaml)
        if (!result.success) {
          throw new IncusError(`Malformed Capsule Blueprint: ${file}. Validation failed.`, 'VALIDATION_ERROR', result.error.format())
        }
        const definition = result.data
        console.log(`[QilnWorker Registry] Loaded capsule blueprint '${definition.name}' from ${file}.`)
        this.cache.set(definition.name, definition)
      }
      console.log(`[QilnWorker Registry] Successfully loaded ${this.cache.size} capsule blueprints.`)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`[QilnWorker Registry] FATAL: Capsule blueprint directory not found at '${directory}'. Please ensure the catalog exists.`)
        throw error
      }
      console.error(`[QilnWorker Registry] FATAL: Failed to load capsule blueprints from ${directory}`, error)
      throw error
    }
  }

  /**
   * Retrieves a validated capsule blueprint by name.
   */
  public get(name: string): CapsuleBlueprint | undefined {
    return this.cache.get(name)
  }

  /**
   * Returns all loaded capsule blueprints.
   */
  public getAll(): CapsuleBlueprint[] {
    return Array.from(this.cache.values())
  }
}
