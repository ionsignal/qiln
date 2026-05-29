import { defineComponent, h } from 'vue'

export const Icon = defineComponent({
  name: 'Icon',
  props: {
    path: {
      type: String,
      required: true,
    },
    size: {
      type: [Number, String],
      default: 24,
    },
  },
  setup(props) {
    return () =>
      h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          viewBox: '0 0 24 24',
          width: props.size,
          height: props.size,
          fill: 'currentColor',
        },
        [h('path', { d: props.path })],
      )
  },
})
