<template>
  <div class="center">
    <div class="error-card">
      <n-result :status="is404 ? '404' : '500'" :title="abortTitle" :description="abortDescription">
        <template #icon>
          <n-text type="warning"><icon size="72" :path="mdiAlertRhombus" /></n-text>
        </template>
        <template #footer>
          <div class="action-buttons">
            <n-button ghost size="small" type="default" @click="goHome">Go Home</n-button>
          </div>
        </template>
      </n-result>
    </div>
  </div>
</template>

<script lang="ts" setup>
  import { usePageContext } from '@/composables/usePageContext'
  import { NText, NResult, NButton } from 'naive-ui'
  import { navigate } from 'vike/client/router'
  import { Icon } from '@/components/Icon'
  import { mdiAlertRhombus } from '@mdi/js'

  const pageContext = usePageContext()
  const { is404, abortReason } = pageContext.value
  const abortTitle = is404 ? 'Page Not Found' : 'Server Error'
  const abortDescription = is404
    ? "The page you're looking for doesn't exist."
    : abortReason
      ? (abortReason as string)
      : 'Something unexpected went wrong. Please try again later.'
  const goHome = () => {
    navigate('/')
  }
</script>

<style scoped>
  .center {
    height: calc(100vh);
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .error-card {
    padding: 25px;
    max-width: 512px;
    border-radius: 8px;
    border: solid 1px #323232;
  }
</style>
