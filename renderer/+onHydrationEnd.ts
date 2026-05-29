// https://vike.dev/onHydrationEnd
import type { PageContextClient } from 'vike/types'
import { transitionBus } from '@/renderer/utils/transitions'

const onHydrationEnd = async (_: PageContextClient) => {
  transitionBus.emit('finish')
}

export { onHydrationEnd }
