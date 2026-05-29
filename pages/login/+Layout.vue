<template>
  <n-config-provider :theme="darkTheme" :locale="enUS" :date-locale="dateEnUS" :theme-overrides="adminThemeOverrides">
    <n-global-style />
    <n-message-provider>
      <n-layout position="absolute" class="login-layout">
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
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: rgb(16, 16, 20);
  }
</style>