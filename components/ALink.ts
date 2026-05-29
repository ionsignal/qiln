import { defineComponent, h } from 'vue'
import { navigate } from 'vike/client/router'
export const ALink = defineComponent({
  name: 'ALink',
  props: {
    href: {
      type: String,
      required: true,
    },
  },
  setup(props, { slots }) {
    const doNavigate = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
        return
      }
      event.preventDefault()
      navigate(props.href)
    }
    return () =>
      h(
        'a',
        {
          href: props.href,
          onClick: doNavigate,
        },
        slots.default ? slots.default() : '',
      )
  },
})
