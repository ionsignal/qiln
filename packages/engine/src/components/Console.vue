<template>
  <div class="qiln-console" :class="{ 'is-dragging': consoleState.isDragging.value }" :style="{ height: consoleHeight }">
    <div v-show="consoleState.isExpanded.value" class="console-drag-handle" @mousedown="startDrag"></div>
    <ConsoleTabBar />
    <div v-show="consoleState.isExpanded.value" class="console-body">
      <ConsoleLogView
        v-for="tab in consoleState.tabs.value"
        :key="tab.id"
        :tab-id="tab.id"
        v-show="consoleState.activeTabId.value === tab.id" />
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, onUnmounted } from 'vue'
  import { useConsole } from '../composables/useConsole'
  import ConsoleTabBar from './ConsoleTabBar.vue'
  import ConsoleLogView from './ConsoleLogView.vue'

  const consoleState = useConsole()

  const consoleHeight = computed(() => {
    return consoleState.isExpanded.value ? `${consoleState.panelHeight.value}px` : '32px'
  })

  const handleMouseMove = (e: MouseEvent) => {
    consoleState.onResizeMove(e.clientY)
  }

  const stopDrag = () => {
    consoleState.stopResize()
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', stopDrag)
    document.documentElement.removeEventListener('mouseleave', stopDrag)
  }

  const startDrag = (e: MouseEvent) => {
    e.preventDefault()
    consoleState.startResize()
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', stopDrag)
    document.documentElement.addEventListener('mouseleave', stopDrag)
  }

  onMounted(() => {
    consoleState.init()
  })

  onUnmounted(() => {
    consoleState.destroy()
    stopDrag()
  })
</script>

<style scoped>
  .qiln-console {
    display: flex;
    flex-direction: column;
    width: 100%;
    background-color: rgb(12, 12, 15);
    border-top: 1px solid var(--n-border-color);
    position: relative;
    z-index: 10;
    transition: height 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .qiln-console.is-dragging {
    transition: none;
  }

  .console-drag-handle {
    position: absolute;
    top: -3px;
    left: 0;
    right: 0;
    height: 6px;
    cursor: ns-resize;
    z-index: 20;
  }

  .console-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
