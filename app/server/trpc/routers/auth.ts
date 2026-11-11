import { z } from 'zod'
import bcrypt from 'bcrypt'
import { randomBytes } from 'node:crypto'
import { users } from '@/db/users'
import { TRPCError } from '@trpc/server'
import { Attempts } from '@server/trpc/attempts'
import { protectedProcedure, publicProcedure, router } from '@server/trpc/procedures'

const BCRYPT_COST = 12
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const SIGNUP_WINDOW_MS = 24 * 60 * 60 * 1000

// Compared against when no account matches, so response time does not reveal
// whether an email is registered.
const missingAccountHash = bcrypt.hash(randomBytes(16).toString('hex'), BCRYPT_COST)

// Failed logins stay counted and a successful login releases its own attempt.
// A signup holds its slot only while it succeeds.
const loginByAddress = new Attempts({ limit: 10, windowMs: LOGIN_WINDOW_MS })
const loginByAccount = new Attempts({ limit: 5, windowMs: LOGIN_WINDOW_MS })
const signupByAddress = new Attempts({ limit: 2, windowMs: SIGNUP_WINDOW_MS })

function throttled(): TRPCError {
  return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again later.' })
}

export const authRouter = router({
  signup: publicProcedure
    .input(
      z.object({
        email: z.email('Invalid email address.'),
        username: z.string().min(3, 'Username must be at least 3 characters long.'),
        password: z.string().min(8, 'Password must be at least 8 characters long.'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!signupByAddress.take(ctx.clientAddress)) {
        throw throttled()
      }
      try {
        const existingUser = await ctx.db.query.users.findFirst({
          where: {
            OR: [{ username: input.username }, { email: input.email }],
          },
          columns: { id: true },
        })
        if (existingUser) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Username or email is already registered.' })
        }
        const [user] = await ctx.db
          .insert(users)
          .values({
            username: input.username,
            email: input.email,
            password: await bcrypt.hash(input.password, BCRYPT_COST),
          })
          .returning({ id: users.id })
        await ctx.fastify.req.session.regenerate(user.id)
      } catch (error: unknown) {
        signupByAddress.release(ctx.clientAddress)
        throw error
      }
      return { success: true }
    }),

  login: publicProcedure
    .input(z.object({ email: z.email(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const account = input.email.toLowerCase()
      if (!loginByAddress.take(ctx.clientAddress) || !loginByAccount.take(account)) {
        throw throttled()
      }
      const user = await ctx.db.query.users.findFirst({
        where: {
          email: input.email,
        },
      })
      const passwordMatches = await bcrypt.compare(input.password, user?.password ?? (await missingAccountHash))
      if (!user || !passwordMatches) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' })
      }
      await ctx.fastify.req.session.regenerate(user.id)
      loginByAddress.release(ctx.clientAddress)
      loginByAccount.release(account)
      return { success: true }
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.fastify.req.session.destroy()
    return { success: true }
  }),
})
