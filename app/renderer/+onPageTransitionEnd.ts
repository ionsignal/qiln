// https://vike.dev/onPageTransitionEnd
import type { PageContextClient } from 'vike/types'
import { transitionBus } from '@/renderer/utils/transitions'

const onPageTransitionEnd = async (_: PageContextClient) => {
  transitionBus.emit('finish')
}

export { onPageTransitionEnd }
