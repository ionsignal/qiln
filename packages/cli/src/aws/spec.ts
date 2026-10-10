export const AWS_RECORD_VERSION = Object.freeze({
  connection: 2,
  pending: 1,
})

export const AWS_SPEC = Object.freeze({
  cliVersion: '2.37.9',
  sdkVersion: '3.1146.0',
  defaultName: 'default',
  defaultRegion: 'us-west-2',
  profile: 'qiln',
  children: Object.freeze({
    auth: 'aws.js',
    iam: 'iam.js',
  }),
  loginTimeoutMs: 15 * 60 * 1_000,
  requestTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
  iam: Object.freeze({
    requestTimeoutMs: 120_000,
    maximumPages: 20,
    verification: Object.freeze({
      timeoutMs: 15_000,
      delayMs: 1_000,
      attempts: 8,
    }),
  }),
  state: {
    directory: 'aws',
    connections: 'connections',
    lock: 'connections.lock',
    connection: 'connection.json',
    pending: 'pending.json',
    root: 'root',
    auth: 'auth',
    config: 'config',
    credentials: 'credentials',
    cache: 'cache',
  },
  limits: {
    record: 65_536,
    config: 65_536,
    cache: 262_144,
  },
})
