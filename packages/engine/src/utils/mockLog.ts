export interface LogLine {
  id: number
  timestamp: string
  source?: string
  sourceColor?: string
  message: string
}

export type LogCategory = 'system' | 'vllm' | 'minecraft' | 'generic'

interface LogTemplate {
  source?: string
  sourceColor?: string
  messages: string[]
}

const colors = {
  blue: '#3b82f6',
  emerald: '#10b981',
  purple: '#8b5cf6',
  amber: '#f59e0b',
  pink: '#ec4899',
  cyan: '#06b6d4',
  green: '#22c55e',
  yellow: '#eab308',
  gray: '#94a3b8',
  indigo: '#6366f1',
}

const templates: Record<LogCategory, LogTemplate[]> = {
  system: [
    {
      source: '[NATS]',
      sourceColor: colors.blue,
      messages: ['Connected to nats://10.10.10.1:4222', 'Reconnecting to cluster...', 'Ping latency: 1.2ms', 'Subscribed to gbl.evt.>'],
    },
    {
      source: '[Caddy]',
      sourceColor: colors.emerald,
      messages: ['GET /api/v1/health 200 1.2ms', 'Reloading configuration...', 'Successfully obtained certificate for *.ionsignal.com'],
    },
    {
      source: '[Qiln]',
      sourceColor: colors.purple,
      messages: [
        "Instance 'prod-vllm-01' state → online",
        "Instance 'paper-survival' state → starting",
        'Reconciling database state with Incus...',
        'Dispatcher envelope routed successfully.',
      ],
    },
    {
      source: '[ZFS]',
      sourceColor: colors.amber,
      messages: [
        'Snapshot is-nvme-pool/user-abc-world@auto-daily created',
        'Cloning dataset for new instance...',
        'Scrub completed with 0 errors',
      ],
    },
  ],
  vllm: [
    {
      source: '[vLLM]',
      sourceColor: colors.pink,
      messages: [
        "Loading model 'Qwen3-30B-A3B'...",
        'Capturing CUDA graph for batch size 1...',
        'Capturing CUDA graph for batch size 16...',
        'Model loaded successfully in 14.2s',
      ],
    },
    {
      source: '[GPU0]',
      sourceColor: colors.cyan,
      messages: ['VRAM: 14.2/16.0 GB allocated', 'Temperature: 68°C | Fan: 45%', 'PCIe P2P DMA enabled'],
    },
    {
      source: '[Engine]',
      sourceColor: colors.purple,
      messages: ['Throughput: 112.4 tokens/s', 'KV Cache allocated: 8192 slots', 'Prefix caching hit rate: 84%'],
    },
    {
      source: '[HTTP]',
      sourceColor: colors.indigo,
      messages: ['POST /v1/chat/completions 200 845ms', 'POST /v1/completions 200 120ms', 'GET /health 200 1ms'],
    },
  ],
  minecraft: [
    {
      source: '[Server]',
      sourceColor: colors.green,
      messages: [
        'Done (3.2s)! For help, type "help"',
        "Saving chunks for level 'ServerLevel'...",
        'Starting minecraft server version 1.20.4',
        'Loading properties',
      ],
    },
    {
      source: '[Player]',
      sourceColor: colors.yellow,
      messages: ['Steve joined the game', 'Alex left the game', 'Steve earned the achievement [Getting Wood]'],
    },
    {
      source: '[Chunk]',
      sourceColor: colors.amber,
      messages: ['Preparing spawn area: 78%', 'Preparing spawn area: 95%', 'Time elapsed: 2450 ms'],
    },
  ],
  generic: [
    {
      source: '[Process]',
      sourceColor: colors.gray,
      messages: ['CPU: 12% | RSS: 245MB', 'Garbage collection completed', 'Worker thread spawned'],
    },
    {
      source: '[HTTP]',
      sourceColor: colors.indigo,
      messages: ['GET / 200 2ms', 'POST /api/data 201 45ms', 'GET /assets/style.css 304 1ms'],
    },
    {
      source: '[Health]',
      sourceColor: colors.emerald,
      messages: ['All checks passed', 'Database connection active', 'Cache hit ratio: 92%'],
    },
  ],
}

let nextId = 1

function getTimestamp(): string {
  const now = new Date()
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

/**
 * Generates a randomized LogLine based on the provided category.
 * Used exclusively for the mock UI phase.
 */
export function generateMockLog(category: LogCategory = 'generic'): LogLine {
  const cats = templates[category] || templates.generic
  const template = cats[Math.floor(Math.random() * cats.length)]
  const message = template.messages[Math.floor(Math.random() * template.messages.length)]
  return {
    id: nextId++,
    timestamp: getTimestamp(),
    source: template.source,
    sourceColor: template.sourceColor,
    message,
  }
}
