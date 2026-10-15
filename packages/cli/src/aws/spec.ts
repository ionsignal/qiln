export const AWS_RECORD_VERSION = Object.freeze({
  connection: 2,
  pending: 1,
})

export const AWS_SPEC = Object.freeze({
  cliVersion: '2.37.9',
  sdkVersion: '3.1150.0',
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
    defaultName: 'deployment',
    defaultCidr: '172.16.0.0/16',
    subnetPrefix: 24,
    maximumZones: 6,
    maximumSteps: 64,
    maximumRefusals: 3,
    // Instance start and termination, and the interface deletion that follows
    // it, outlast network resources. These budgets are provisional until an
    // operator walkthrough measures them. The poll must stay inside the child
    // request deadline minus its 5 second reserve.
    requestTimeoutMs: 300_000,
    maximumPages: 20,
    observation: Object.freeze({
      timeoutMs: 240_000,
      delayMs: 3_000,
      attempts: 80,
    }),
  }),
  compute: Object.freeze({
    instanceType: 'g7e.12xlarge',
    storage: Object.freeze({
      volumeType: 'gp3',
      iops: 3_000,
      throughput: 250,
      rootSizeGiB: 75,
      dataSizeGiB: 250,
    }),
    launch: Object.freeze({
      count: 1,
      purchase: 'on-demand',
      dataDeviceName: '/dev/sdf',
      rootDeleteOnTermination: true,
      dataDeleteOnTermination: false,
      metadata: Object.freeze({
        httpEndpoint: 'enabled',
        httpTokens: 'required',
        httpPutResponseHopLimit: 1,
        httpProtocolIpv6: 'disabled',
        instanceMetadataTags: 'disabled',
      }),
      network: Object.freeze({
        deviceIndex: 0,
        networkCardIndex: 0,
        associatePublicIp: false,
        deleteOnTermination: true,
      }),
      key: Object.freeze({
        algorithm: 'ed25519',
        passphrase: 'none',
        protection: 'owner-only directory 0700, file 0600',
      }),
      elasticIp: Object.freeze({
        allowReassociation: false,
      }),
      tagged: Object.freeze(['instance', 'volume', 'network-interface', 'key-pair', 'elastic-ip']),
    }),
    image: Object.freeze({
      name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 26.04) 20261006',
      release: '20261006',
      owner: 'amazon',
      architecture: 'x86_64',
      documentation: 'https://docs.aws.amazon.com/dlami/latest/devguide/aws-deep-learning-ami-gpubaseoss-ul2604-2026-10-08.html',
      documented: Object.freeze({
        os: 'Ubuntu 26.04.1 LTS',
        driver: 'NVIDIA 595.91.07',
        cuda: 'CUDA 13.3 at /usr/local/cuda-13.3/',
        kernel: '7.0.0-1014-aws',
      }),
    }),
    discovery: Object.freeze({
      maximumDevices: 32,
      maximumZones: 32,
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
    ssh: 'ssh',
    privateKey: 'admin',
    publicKey: 'admin.pub',
  },
  limits: {
    record: 65_536,
    config: 65_536,
    cache: 262_144,
    privateKey: 4_096,
    publicKey: 4_096,
  },
})
