import { z } from 'zod'
import { publicProcedure, router } from '@server/trpc/procedures'
import { TRPCError } from '@trpc/server'
import { logger } from '@server/utils/logger'

// The data will be considered fresh for 5 minutes.
const CACHE_DURATION_MS = 5 * 60 * 1000

// Define the shape of our cached data
type DiscordCache = {
  data: {
    onlineCount: number
    inviteUrl: string | null
  }
  timestamp: number
}

// Module-level variable to act as our in-memory cache.
let cache: DiscordCache | null = null

// Define the expected shape of the Discord Widget API response
const DiscordWidgetSchema = z.object({
  id: z.string(),
  name: z.string(),
  instant_invite: z.string().nullable(),
  presence_count: z.number(),
})

export const discordRouter = router({
  getWidgetData: publicProcedure.query(async () => {
    // Check for a valid, non-expired cache first.
    if (cache && Date.now() - cache.timestamp < CACHE_DURATION_MS) {
      return cache.data
    }
    const serverId = process.env.DISCORD_SERVER_ID
    const inviteUrl = process.env.DISCORD_INVITE_URL
    if (!serverId) {
      logger.error('DISCORD_SERVER_ID is not configured in environment variables.')
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Discord integration is not configured correctly on the server.',
      })
    }
    const widgetApiUrl = `https://discord.com/api/v9/guilds/${serverId}/widget.json`
    try {
      const response = await fetch(widgetApiUrl)
      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(`Discord API responded with status ${response.status}: ${errorBody}`)
      }
      const data = await response.json()
      const parsedData = DiscordWidgetSchema.safeParse(data)
      if (!parsedData.success) {
        // Log structured error for debugging
        logger.warn({ errors: parsedData.error.format() }, '[Discord] Widget API schema mismatch')
        throw new Error(`Invalid data structure from Discord API: ${parsedData.error.message}`)
      }
      const freshData = {
        onlineCount: parsedData.data.presence_count,
        inviteUrl: inviteUrl || parsedData.data.instant_invite,
      }
      // Update the cache with the fresh data and timestamp.
      cache = {
        data: freshData,
        timestamp: Date.now(),
      }
      return freshData
    } catch (error) {
      logger.error({ err: error }, 'An error occurred while fetching Discord widget data.')
      if (cache) {
        logger.warn('Serving stale Discord widget data due to fetch failure.')
        return cache.data
      }
      return {
        onlineCount: 0,
        inviteUrl: inviteUrl || '#',
      }
    }
  }),
})
