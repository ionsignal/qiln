import fp from 'fastify-plugin'
import multipart from '@fastify/multipart'

/**
 * Registers the @fastify/multipart plugin. Consider adding limits (fileSize,
 * files, etc.) for security. See:
 * https://github.com/fastify/fastify-multipart#plugin-options.
 */
export default fp(
  async fastify => {
    const limitsConfig = fastify.config.multipart
    fastify.register(multipart, {
      limits: {
        fieldNameSize: 100, // Max field name size in bytes
        fieldSize: limitsConfig.maxFieldSizeBytes, // Max field value size in bytes (e.g., 1MB for assetId)
        fileSize: limitsConfig.maxFileSizeBytes, // Max file size in bytes (e.g., 50GB)
        files: limitsConfig.maxFiles, // Max number of file fields
        parts: limitsConfig.maxParts, // Max total parts (fields + files)
        headerPairs: limitsConfig.maxHeaderPairs, // Max header pairs per part
      },
    })
    fastify.log.info(
      {
        limits: {
          fieldNameSize: 100,
          fieldSize: limitsConfig.maxFieldSizeBytes,
          fileSize: limitsConfig.maxFileSizeBytes,
          files: limitsConfig.maxFiles,
          parts: limitsConfig.maxParts,
          headerPairs: limitsConfig.maxHeaderPairs,
        },
      },
      'Registered @fastify/multipart plugin using decorated config',
    )
  },
  {
    name: 'multipart',
    dependencies: [], // Add dependencies if needed, e.g., ['config']
  },
)
