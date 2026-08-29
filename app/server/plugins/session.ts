import fp from 'fastify-plugin'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { sessions, users } from '@server/db/schema'
import type { Database } from '@server/db'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { AuthenticatedUser } from '@/types/entities'
import type { CookiesConfig } from '@/types/config'

/**
 * Session Class Manages the lifecycle of a user session, bridging Drizzle and
 * Fastify.
 */
export class Session {
  private _user: AuthenticatedUser | null = null
  private _sessionId: string | null = null
  private _expiresAt: Date | null = null

  constructor(
    private readonly db: Database,
    private readonly request: FastifyRequest,
    private readonly reply: FastifyReply,
    private readonly config: CookiesConfig,
    data?: {
      session: typeof sessions.$inferSelect
      user: typeof users.$inferSelect
    },
  ) {
    if (data) {
      this._sessionId = data.session.id
      this._expiresAt = data.session.expiresAt
      this._user = {
        session: null,
        id: data.user.id,
        username: data.user.username,
        avatar: data.user.avatar,
        isAdmin: data.user.isAdmin,
      }
    }
  }

  /**
   * Returns the authenticated user or null if guest.
   */
  get user() {
    return this._user
  }

  /**
   * Returns the current session ID or null if guest.
   */
  get id() {
    return this._sessionId
  }

  /**
   * Sliding Window Expiration: Extends the session validity if we are past the
   * halfway point of the maxAge.
   */
  async touch() {
    if (!this._sessionId || !this._expiresAt) return
    const now = Date.now()
    const maxAgeMs = this.config.maxAge * 1000
    const remaining = this._expiresAt.getTime() - now
    // If less than 50% of the session life remains, refresh it.
    if (remaining < maxAgeMs * 0.5) {
      const newExpires = new Date(now + maxAgeMs)
      // Update DB
      await this.db
        .update(sessions)
        .set({ expiresAt: newExpires })
        .where(eq(sessions.id, this._sessionId))
        .catch(err => this.request.log.error({ err }, '[Session] Failed to touch session in DB'))
      // Update Local State
      this._expiresAt = newExpires
      // Update Cookie
      this.setCookie(this._sessionId, newExpires)
    }
  }

  /**
   * Login: Creates a new session in the DB and sets the cookie.
   */
  async regenerate(userId: string) {
    const sessionId = randomBytes(32).toString('hex')
    const maxAgeMs = this.config.maxAge * 1000
    const expiresAt = new Date(Date.now() + maxAgeMs)
    // Insert into DB
    await this.db.insert(sessions).values({
      id: sessionId,
      userId: userId,
      expiresAt,
    })
    // Update Local State
    this._sessionId = sessionId
    this._expiresAt = expiresAt
    // Note: We do not automatically fetch/hydrate 'this._user' here.
    // The caller (Auth Router) usually handles the immediate response
    // or the next request will hydrate it.
    // Set Cookie
    this.setCookie(sessionId, expiresAt)
  }

  /**
   * Logout: Deletes the session from the DB and clears the cookie.
   */
  async destroy() {
    if (this._sessionId) {
      await this.db
        .delete(sessions)
        .where(eq(sessions.id, this._sessionId))
        .catch(err => this.request.log.error({ err }, '[Session] Failed to destroy session in DB'))
    }
    this._sessionId = null
    this._user = null
    this._expiresAt = null
    this.reply.clearCookie(this.config.name, {
      path: this.config.path,
      domain: this.config.domain,
    })
  }

  private setCookie(sessionId: string, expiresAt: Date) {
    const isProd = process.env.NODE_ENV === 'production'
    this.reply.setCookie(this.config.name, sessionId, {
      path: this.config.path,
      domain: this.config.domain,
      httpOnly: true,
      secure: isProd,
      sameSite: this.config.sameSite as boolean | 'lax' | 'strict' | 'none' | undefined,
      expires: expiresAt,
    })
  }
}

export default fp(
  async fastify => {
    const config = fastify.config.cookies
    const db = fastify.db
    fastify.decorateRequest('session', null as unknown as Session)
    fastify.addHook('onRequest', async (req, reply) => {
      const sessionId = req.cookies[config.name]
      // Default: Guest Session
      if (!sessionId) {
        req.session = new Session(db, req, reply, config)
        req.raw.session = req.session // Bridge session to raw request for tRPC WS support
        return
      }
      // Lookup Session
      const result = await db.query.sessions.findFirst({
        where: {
          id: sessionId,
          expiresAt: {
            gt: new Date(), // Object syntax for 'greater than'
          },
        },
        with: {
          user: true,
        },
      })
      if (result && result.user) {
        // Authenticated Session
        req.session = new Session(db, req, reply, config, {
          session: result,
          user: result.user,
        })
        // Attempt to extend session life if needed
        await req.session.touch()
      } else {
        // Invalid or Expired Session -> Treat as Guest
        req.session = new Session(db, req, reply, config)
        // If the cookie existed but was invalid, clear it
        if (sessionId) {
          // Use config.name
          reply.clearCookie(config.name, { path: config.path, domain: config.domain })
        }
      }
      // Bridge session to raw request for tRPC WS support
      req.raw.session = req.session
    })
    fastify.log.info('[Session] Plugin registered')
  },
  {
    name: 'session',
    dependencies: ['db', 'middleware'],
  },
)
