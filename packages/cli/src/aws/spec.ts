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
    ec2: 'ec2.js',
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
  deployment: Object.freeze({
    defaultCidr: '172.16.0.0/16',
    maximumRemovals: 3,
    requestTimeoutMs: 120_000,
    maximumPages: 20,
    observation: Object.freeze({
      timeoutMs: 60_000,
      delayMs: 2_000,
      attempts: 30,
    }),
  }),
  state: {
    directory: 'aws',
    connections: 'connections',
    deployments: 'deployments',
    lock: 'connections.lock',
    connection: 'connection.json',
    deployment: 'deployment.json',
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
