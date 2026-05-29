<template>
  <div class="micro-sparkline-wrapper">
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" class="micro-sparkline-svg">
      <g v-if="showGrid">
        <line x1="0" y1="0" x2="100" y2="0" stroke="currentColor" opacity="0.1" vector-effect="non-scaling-stroke" />
        <line x1="0" y1="7.5" x2="100" y2="7.5" stroke="currentColor" opacity="0.04" vector-effect="non-scaling-stroke" />
        <line x1="0" y1="15" x2="100" y2="15" stroke="currentColor" opacity="0.1" vector-effect="non-scaling-stroke" />
        <line x1="0" y1="22.5" x2="100" y2="22.5" stroke="currentColor" opacity="0.04" vector-effect="non-scaling-stroke" />
        <line x1="0" y1="30" x2="100" y2="30" stroke="currentColor" opacity="0.1" vector-effect="non-scaling-stroke" />
      </g>
      <polyline
        :points="points"
        fill="none"
        :stroke="color"
        :stroke-width="strokeWidth"
        vector-effect="non-scaling-stroke"
        stroke-linecap="round"
        stroke-linejoin="round" />
    </svg>
    <template v-if="showLabels">
      <span class="spark-label max-label">{{ valueFormatter ? valueFormatter(effectiveMax) : effectiveMax.toFixed(1) }}</span>
      <span class="spark-label min-label">{{ valueFormatter ? valueFormatter(effectiveMin) : effectiveMin.toFixed(1) }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'

  const props = withDefaults(
    defineProps<{
      data?: number[]
      color?: string
      strokeWidth?: number
      min?: number
      max?: number
      showGrid?: boolean
      showLabels?: boolean
      valueFormatter?: (val: number) => string
    }>(),
    {
      data: () => [],
      color: 'currentColor',
      strokeWidth: 2,
      showGrid: false,
      showLabels: false,
    },
  )

  const effectiveMax = computed(() => {
    if (props.max !== undefined) return props.max
    if (!props.data || props.data.length === 0) return 100
    return Math.max(...props.data)
  })

  const effectiveMin = computed(() => {
    if (props.min !== undefined) return props.min
    if (!props.data || props.data.length === 0) return 0
    return Math.min(...props.data)
  })

  const points = computed(() => {
    if (!props.data || props.data.length === 0) return ''
    const range = Math.max(effectiveMax.value - effectiveMin.value, 1)
    const step = 100 / Math.max(props.data.length - 1, 1)
    return props.data
      .map((val, i) => {
        const x = i * step
        const clampedVal = Math.max(effectiveMin.value, Math.min(effectiveMax.value, val))
        const y = 30 - ((clampedVal - effectiveMin.value) / range) * 30
        return `${x},${y}`
      })
      .join(' ')
  })
</script>

<style scoped>
  .micro-sparkline-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
  }

  .micro-sparkline-svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .spark-label {
    position: absolute;
    right: 4px;
    font-size: 9px;
    font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.4);
    pointer-events: none;
    line-height: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  }

  .max-label {
    top: 0px;
  }

  .min-label {
    bottom: 0px;
  }
</style>
