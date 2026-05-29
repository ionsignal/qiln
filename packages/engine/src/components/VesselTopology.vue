<template>
  <div class="vessel-topology-wrapper">
    <VueFlow
      :id="flowId"
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      fit-view-on-init
      class="qiln-vue-flow" />
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  // @ts-ignore
  import '@vue-flow/core/dist/style.css'
  // @ts-ignore
  import '@vue-flow/core/dist/theme-default.css'
  import { VueFlow, useVueFlow } from '@vue-flow/core'
  import type { WorkspaceVessel } from '../types'

  const props = withDefaults(
    defineProps<{
      vessel: WorkspaceVessel | null
      interactive?: boolean
      mini?: boolean
      flowId?: string
    }>(),
    {
      interactive: true,
      mini: false,
      flowId: 'vessel-topology-flow',
    },
  )

  const { fitView } = useVueFlow(props.flowId)
  const nodes = computed(() => {
    if (!props.vessel) return []
    const baseNodes = [{ id: 'vessel-center', position: { x: 200, y: 100 }, label: props.vessel.name }]
    const netNodes = (props.vessel.ports || []).map((port, idx) => ({
      id: `net-${port.port}`,
      position: { x: 0, y: idx * 50 },
      label: `Port: ${port.port}`,
    }))
    const volNodes = (props.vessel.volumes || []).map((vol, idx) => ({
      id: `vol-${idx}`,
      position: { x: 400, y: idx * 50 },
      label: `Vol: ${vol.name}`,
    }))
    return [...baseNodes, ...netNodes, ...volNodes]
  })
  const edges = computed(() => {
    if (!props.vessel) return []
    const netEdges = (props.vessel.ports || []).map(port => ({
      id: `edge-net-${port.port}`,
      source: `net-${port.port}`,
      target: 'vessel-center',
      animated: true,
    }))
    const volEdges = (props.vessel.volumes || []).map((_, idx) => ({
      id: `edge-vol-${idx}`,
      source: 'vessel-center',
      target: `vol-${idx}`,
    }))
    return [...netEdges, ...volEdges]
  })

  defineExpose({ fitView })
</script>

<style scoped>
  .vessel-topology-wrapper {
    height: 100%;
    width: 100%;
    background-color: var(--n-color);
  }
</style>
