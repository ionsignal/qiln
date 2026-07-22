import bcrypt from 'bcrypt'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { users } from '@server/db/schema'
import { publicProcedure, router } from '@server/trpc/procedures'

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
      const existingUser = await ctx.db.query.users.findFirst({
        where: {
          OR: [{ username: input.username }, { email: input.email }],
        },
      })
      if (existingUser) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: existingUser.username === input.username ? 'Username taken.' : 'Email registered.',
        })
      }
      const hashedPassword = await bcrypt.hash(input.password, 12)
      const userId = await ctx.db.transaction(async tx => {
        // Insert Host User
        const [newUser] = await tx
          .insert(users)
          .values({
            username: input.username,
            email: input.email,
            password: hashedPassword,
          })
          .returning({ id: users.id })
        if (!newUser) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create user.' })
        }
        return newUser.id
      })
      // Use session plugin to regenerate session
      await ctx.fastify.req.session.regenerate(userId)
      return { success: true }
    }),

  login: publicProcedure
    .input(z.object({ email: z.string().email(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.query.users.findFirst({
        where: {
          email: input.email,
        },
      })
      if (!user || !(await bcrypt.compare(input.password, user.password))) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' })
      }
      // Use session plugin to regenerate session
      await ctx.fastify.req.session.regenerate(user.id)
      return { success: true }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    // Use session plugin to destroy session
    await ctx.fastify.req.session.destroy()
    return { success: true }
  }),
})
