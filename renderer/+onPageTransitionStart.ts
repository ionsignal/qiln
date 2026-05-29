// https://vike.dev/onPageTransitionStart
import type { PageContextClient } from 'vike/types'
import { transitionBus } from '@/renderer/utils/transitions'

const onPageTransitionStart = async (_: PageContextClient) => {
  transitionBus.emit('start')
}

export { onPageTransitionStart }
