import { ref, shallowReactive, provide, inject, type InjectionKey, type Ref } from 'vue'
import { generateMockLog, type LogLine, type LogCategory } from '../utils/mockLog'

export interface ConsoleTab {
  id: string
  label: string
  closeable: boolean
  status?: string // e.g., 'online', 'offline', 'starting', 'stopping', 'error'
  lines: LogLine[] // Shallow reactive array to prevent reactivity choke
  isAutoScroll: boolean
}

export interface ConsoleState {
  isExpanded: Ref<boolean>
  panelHeight: Ref<number>
  isDragging: Ref<boolean>
  tabs: Ref<ConsoleTab[]>
  activeTabId: Ref<string>
  init: () => void
  destroy: () => void
  openVesselTab: (id: string, label: string, status: string, category?: LogCategory) => void
  closeTab: (id: string) => void
  focusTab: (id: string) => void
  pushLine: (tabId: string, line: LogLine) => void
  startResize: () => void
  stopResize: () => void
  onResizeMove: (clientY: number) => void
  clearTabs: () => void
}

const ConsoleInjectionKey: InjectionKey<ConsoleState> = Symbol('QilnConsole')

/**
 * Provides the global state for the Qiln Console Panel. Must be called exactly
 * once at the Layout level.
 */
export function provideConsole(): ConsoleState {
  const isExpanded = ref(false)
  const panelHeight = ref(0)
  const isDragging = ref(false)
  const activeTabId = ref('')
  const intervals = new Map<string, number>()
  const tabs = ref<ConsoleTab[]>([])

  /**
   * Spawns a recursive timeout to generate randomized logs.
   */
  function startMockGenerator(tabId: string, category: LogCategory) {
    if (intervals.has(tabId)) return
    const tick = () => {
      pushLine(tabId, generateMockLog(category))
      const nextDelay = Math.floor(Math.random() * 1500) + 500
      intervals.set(tabId, window.setTimeout(tick, nextDelay))
    }
    intervals.set(tabId, window.setTimeout(tick, 500))
  }

  function stopMockGenerator(tabId: string) {
    const intervalId = intervals.get(tabId)
    if (intervalId !== undefined) {
      window.clearTimeout(intervalId)
      intervals.delete(tabId)
    }
  }

  /**
   * Pushes a line to a specific tab's ring buffer. Enforces a 5000-line cap to
   * prevent DOM/memory bloat.
   */
  function pushLine(tabId: string, line: LogLine) {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    tab.lines.push(line)
    if (tab.lines.length > 5000) {
      tab.lines.shift()
    }
  }

  /**
   * Creates or focuses a vessel tab and starts its log stream.
   */
  function openVesselTab(id: string, label: string, status: string, category: LogCategory = 'generic') {
    const existing = tabs.value.find(t => t.id === id)
    if (existing) {
      existing.status = status
      focusTab(id)
      return
    }
    tabs.value.push({
      id,
      label,
      closeable: true,
      status,
      lines: shallowReactive([]),
      isAutoScroll: true,
    })
    focusTab(id)
    startMockGenerator(id, category)
  }

  /**
   * Closes a tab, stops its generator, and focuses the nearest neighbor.
   */
  function closeTab(id: string) {
    const index = tabs.value.findIndex(t => t.id === id)
    if (index === -1) return
    const tab = tabs.value[index]
    if (!tab.closeable) return
    stopMockGenerator(id)
    tabs.value.splice(index, 1)
    if (activeTabId.value === id) {
      const nextTab = tabs.value[index - 1] || tabs.value[0]
      if (nextTab) {
        focusTab(nextTab.id)
      } else {
        activeTabId.value = ''
      }
    }
  }

  function focusTab(id: string) {
    activeTabId.value = id
  }

  function startResize() {
    isDragging.value = true
  }

  function stopResize() {
    isDragging.value = false
  }

  /**
   * Computes the new panel height during a drag event. Clamps the height
   * between 20% and 60% of the viewport.
   */
  function onResizeMove(clientY: number) {
    if (!isDragging.value) return
    const newHeight = window.innerHeight - clientY
    const minHeight = window.innerHeight * 0.2
    const maxHeight = window.innerHeight * 0.6
    panelHeight.value = Math.min(Math.max(newHeight, minHeight), maxHeight)
  }

  function clearTabs() {
    intervals.forEach(id => window.clearTimeout(id))
    intervals.clear()
    tabs.value = []
    activeTabId.value = ''
  }

  /**
   * Hydration-safe initializer. Must be called inside onMounted.
   */
  function init() {
    panelHeight.value = Math.round(window.innerHeight * 0.3)
  }

  /**
   * Cleanup method to prevent memory leaks. Must be called inside onUnmounted.
   */
  function destroy() {
    intervals.forEach(id => window.clearTimeout(id))
    intervals.clear()
  }

  const state: ConsoleState = {
    isExpanded,
    panelHeight,
    isDragging,
    tabs,
    activeTabId,
    init,
    destroy,
    openVesselTab,
    closeTab,
    focusTab,
    pushLine,
    startResize,
    stopResize,
    onResizeMove,
    clearTabs,
  }

  provide(ConsoleInjectionKey, state)
  return state
}

/**
 * Injects the global Console state.
 *
 * @throws Error if called outside of a provideConsole hierarchy.
 */
export function useConsole(): ConsoleState {
  const state = inject(ConsoleInjectionKey)
  if (!state) {
    throw new Error('useConsole must be used within a component that calls provideConsole()')
  }
  return state
}
