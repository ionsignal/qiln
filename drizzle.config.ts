import { defineConfig } from 'drizzle-kit'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing. Cannot run Drizzle Kit.')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './app/server/db/schema.ts',
  out: './app/server/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
})
