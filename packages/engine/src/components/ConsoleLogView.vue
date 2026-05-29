<template>
  <div class="console-log-view">
    <div class="log-scroll-container" ref="scrollEl" @scroll="handleScroll">
      <div v-for="line in tab?.lines || []" :key="line.id" class="log-line">
        <span class="log-timestamp">{{ line.timestamp }}</span>
        <span v-if="line.source" class="log-source" :style="{ color: line.sourceColor }">{{ line.source }}</span>
        <span class="log-message">{{ line.message }}</span>
      </div>
      <div class="scroll-anchor"></div>
    </div>
    <div v-show="!tab?.isAutoScroll" class="jump-to-bottom" @click="scrollToBottom(true)">
      <icon :path="mdiArrowDown" :size="14" />
      <span>More logs below</span>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { ref, computed, watch, nextTick } from 'vue'
  import { Icon } from './Icon'
  import { mdiArrowDown } from '@mdi/js'
  import { useConsole } from '../composables/useConsole'

  const props = defineProps<{ tabId: string }>()
  const consoleState = useConsole()
  const tab = computed(() => consoleState.tabs.value.find(t => t.id === props.tabId))
  const scrollEl = ref<HTMLElement | null>(null)

  function handleScroll(e: Event) {
    const el = e.target as HTMLElement
    // 20px threshold to snap to bottom
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    if (tab.value) {
      tab.value.isAutoScroll = isAtBottom
    }
  }

  function scrollToBottom(force = false) {
    if (tab.value && force) {
      tab.value.isAutoScroll = true
    }
    nextTick(() => {
      if (scrollEl.value) {
        scrollEl.value.scrollTop = scrollEl.value.scrollHeight
      }
    })
  }

  // Watch for new lines and auto-scroll if enabled
  watch(
    () => tab.value?.lines.length,
    () => {
      if (tab.value?.isAutoScroll) {
        scrollToBottom()
      }
    },
  )
</script>

<style scoped>
  .console-log-view {
    position: relative;
    height: 100%;
    width: 100%;
    background-color: rgb(12, 12, 15);
    overflow: hidden;
  }

  .log-scroll-container {
    height: 100%;
    overflow-y: auto;
    overflow-anchor: auto;
    padding: 8px 0;
    box-sizing: border-box;
  }

  .log-line {
    display: flex;
    gap: 12px;
    padding: 2px 16px;
    font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 12px;
    line-height: 1.4;
    overflow-anchor: none;
  }

  .log-line:nth-child(even) {
    background-color: rgba(255, 255, 255, 0.02);
  }

  .log-line:hover {
    background-color: rgba(255, 255, 255, 0.04);
  }

  .log-timestamp {
    color: rgba(255, 255, 255, 0.3);
    flex-shrink: 0;
    user-select: none;
  }

  .log-source {
    font-weight: 600;
    flex-shrink: 0;
  }

  .log-message {
    color: rgba(255, 255, 255, 0.8);
    word-break: break-all;
  }

  .scroll-anchor {
    height: 1px;
    overflow-anchor: auto;
  }

  .jump-to-bottom {
    position: absolute;
    bottom: 16px;
    right: 24px;
    display: flex;
    align-items: center;
    gap: 6px;
    background-color: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(8px);
    color: rgba(255, 255, 255, 0.9);
    padding: 6px 12px;
    border-radius: 16px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    transition: background-color 0.2s;
    z-index: 10;
  }

  .jump-to-bottom:hover {
    background-color: rgba(255, 255, 255, 0.2);
  }
</style>
