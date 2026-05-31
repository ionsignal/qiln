import { computed, ref } from 'vue'
import { darkTheme, enUS, dateEnUS } from 'naive-ui'

// export const loadingBar = useLoadingBar()
export const localNameRef = ref('en-US')
export const themeNameRef = ref('dark')
export const dateFormatNameRef = ref('default')

export const localeRef = computed(() => {
  return enUS
})

export const themeRef = computed(() => {
  return darkTheme
})

export const dateFormatRef = computed(() => {
  return dateEnUS
})
