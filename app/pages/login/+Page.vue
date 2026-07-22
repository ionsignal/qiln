<template>
  <div class="login-container">
    <n-card class="login-card" :bordered="false" size="large">
      <div class="header">
        <n-text style="font-size: 28px; font-weight: 700; letter-spacing: 0.1em">Qiln</n-text>
        <n-text depth="3" style="display: block; margin-top: 8px">Sign in to the Orchestration Engine</n-text>
      </div>
      <n-form ref="formRef" :model="form" :rules="rules" @submit.prevent="handleLogin">
        <n-form-item path="email" label="Email">
          <n-input v-model:value="form.email" placeholder="admin@ionsignal.com" @keydown.enter="handleLogin" />
        </n-form-item>
        <n-form-item path="password" label="Password">
          <n-input
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            placeholder="••••••••"
            @keydown.enter="handleLogin" />
        </n-form-item>
        <n-button block type="primary" attr-type="submit" :loading="loading" style="margin-top: 12px">
          Access System
        </n-button>
      </n-form>
    </n-card>
  </div>
</template>

<script setup lang="ts">
  import { ref } from 'vue'
  import { NCard, NForm, NFormItem, NInput, NButton, NText, useMessage } from 'naive-ui'
  import type { FormInst, FormRules } from 'naive-ui'
  import { trpc } from '@/renderer/api/trpc'
  import { isTRPCClientError } from '@trpc/client'

  const message = useMessage()
  const formRef = ref<FormInst | null>(null)
  const loading = ref(false)

  const form = ref({
    email: '',
    password: '',
  })

  const rules: FormRules = {
    email: [{ required: true, message: 'Email is required', trigger: 'blur' }],
    password: [{ required: true, message: 'Password is required', trigger: 'blur' }],
  }

  async function handleLogin() {
    formRef.value?.validate(async errors => {
      if (!errors) {
        loading.value = true
        try {
          await trpc.auth.login.mutate({
            email: form.value.email,
            password: form.value.password,
          })
          message.success('Authentication successful')
          window.location.href = '/'
        } catch (err) {
          message.error(isTRPCClientError(err) ? err.message : 'Authentication failed')
        } finally {
          loading.value = false
        }
      }
    })
  }
</script>

<style scoped>
  .login-container {
    width: 100%;
    max-width: 420px;
    padding: 24px;
    box-sizing: border-box;
  }

  .login-card {
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
    background-color: rgb(24, 24, 28);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .header {
    text-align: center;
    margin-bottom: 32px;
  }
</style>
