<template>
  <n-config-provider :theme="darkTheme" :locale="enUS" :date-locale="dateEnUS" :theme-overrides="adminThemeOverrides">
    <n-global-style />
    <n-message-provider>
      <n-layout position="absolute" class="login-layout" content-style="display: flex; padding: 24px;">
        <slot />
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
  import 'vfonts/Roboto.css'
  import 'vfonts/FiraCode.css'
  import { NConfigProvider, NGlobalStyle, NMessageProvider, NLayout, darkTheme, enUS, dateEnUS } from 'naive-ui'
  import { adminThemeOverrides } from '@/renderer/layout/adminThemeOverrides'
</script>

<style scoped>
  .login-layout {
    height: 100vh;
    height: 100dvh;
    background-color: rgb(16, 16, 20);
  }
</style>
