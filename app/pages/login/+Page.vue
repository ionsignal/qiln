<template>
  <main class="login-container">
    <n-card class="login-card" :bordered="false" size="large" content-style="padding: clamp(24px, 6vw, 32px);">
      <header class="login-header">
        <img class="login-logo" src="/images/qiln-logo-login.png" alt="Qiln" width="96" height="96" />
      </header>
      <n-form ref="formRef" :model="form" :rules="rules" :disabled="isSubmitting" novalidate @submit.prevent="login">
        <n-form-item path="email" label="Email" :label-props="{ for: 'login-email' }">
          <n-input
            v-model:value="form.email"
            placeholder="you@example.com"
            :input-props="{
              id: 'login-email',
              name: 'email',
              type: 'email',
              autocomplete: 'username',
              autocapitalize: 'none',
              spellcheck: false,
            }" />
        </n-form-item>
        <n-form-item path="password" label="Password" :label-props="{ for: 'login-password' }">
          <n-input
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            placeholder="Enter your password"
            :input-props="{
              id: 'login-password',
              name: 'password',
              autocomplete: 'current-password',
            }" />
        </n-form-item>
        <n-button
          block
          type="primary"
          attr-type="submit"
          :loading="isSubmitting"
          :disabled="isSubmitting"
          class="login-button">
          {{ isSubmitting ? 'Signing in…' : 'Sign in' }}
        </n-button>
      </n-form>
      <div class="access-section">
        <n-text depth="3" class="access-description">Need an account?</n-text>
        <n-button
          block
          secondary
          attr-type="button"
          :disabled="isSubmitting"
          class="login-button"
          @click="requestAccess">
          Request access
        </n-button>
      </div>
    </n-card>
  </main>
</template>

<script setup lang="ts">
  import { ref } from 'vue'
  import { NCard, NForm, NFormItem, NInput, NButton, NText, useMessage } from 'naive-ui'
  import type { FormInst, FormRules } from 'naive-ui'
  import { usePageContext } from '@/composables/usePageContext'
  import { useTRPC } from '@/composables/useTRPC'
  import { isTRPCClientError } from '@trpc/client'

  const pageContext = usePageContext()
  const trpc = useTRPC(pageContext.value)
  const message = useMessage()
  const formRef = ref<FormInst | null>(null)
  const isSubmitting = ref(false)

  const form = ref({
    email: '',
    password: '',
  })

  const rules: FormRules = {
    email: [
      { required: true, message: 'Enter your email address.', trigger: ['input', 'blur'] },
      { type: 'email', message: 'Enter a valid email address.', trigger: ['input', 'blur'] },
    ],
    password: [{ required: true, message: 'Enter your password.', trigger: ['input', 'blur'] }],
  }

  async function login(): Promise<void> {
    if (import.meta.env.SSR || isSubmitting.value || !formRef.value) return
    isSubmitting.value = true
    form.value.email = form.value.email.trim()
    try {
      try {
        await formRef.value.validate()
      } catch {
        return
      }
      await trpc.auth.login.mutate({
        email: form.value.email,
        password: form.value.password,
      })
      message.success('Signed in successfully.')
      // A full navigation hydrates the authenticated session from the server.
      window.location.assign('/admin/capsules')
    } catch (error: unknown) {
      message.error(isTRPCClientError(error) ? error.message : 'Unable to sign in. Please try again.')
    } finally {
      isSubmitting.value = false
    }
  }

  function requestAccess(): void {
    console.info('Request access is not implemented.')
  }
</script>

<style scoped>
  .login-container {
    width: 100%;
    max-width: 408px;
    min-width: 0;
    margin: auto;
    padding: 24px 16px;
    box-sizing: border-box;
  }

  .login-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-bottom: 24px;
    text-align: center;
  }

  .login-logo {
    display: block;
    width: 96px;
    height: 96px;
    object-fit: contain;
  }

  .login-description {
    display: block;
    margin-top: 12px;
    font-size: 12px;
    line-height: 1.5;
  }

  .login-card {
    min-width: 0;
    border-radius: 8px;
    border: 1px solid var(--qiln-surface-border-strong, rgba(255, 255, 255, 0.08));
    background-color: rgb(24, 24, 28);
    box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.4);
  }

  .login-button {
    height: 38px;
    border-radius: 4px;
    font-weight: 500;
  }

  .access-section {
    margin-top: 24px;
    padding-top: 24px;
    border-top: 1px solid var(--qiln-surface-border-strong, rgba(255, 255, 255, 0.08));
    text-align: center;
  }

  .access-description {
    display: block;
    margin-bottom: 12px;
    font-size: 13px;
    line-height: 1.5;
  }

  @media (max-width: 480px) {
    .login-header {
      padding-bottom: 20px;
    }
  }
</style>
