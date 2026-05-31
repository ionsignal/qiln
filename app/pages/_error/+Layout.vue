<template>
  <n-config-provider :theme="theme" :local="local" :date-locale="dateFormat" :theme-overrides="adminThemeOverrides">
    <n-layout style="min-height: 100vh">
      <slot />
    </n-layout>
  </n-config-provider>
</template>

<script lang="ts" setup>
  import 'vfonts/Roboto.css'
  import 'vfonts/FiraCode.css'
  import { adminThemeOverrides } from '@/renderer/layout/adminThemeOverrides'
  import { localeRef, themeRef, dateFormatRef } from '@/store'
  import { NConfigProvider, NLayout } from 'naive-ui'

  const local = localeRef
  const theme = themeRef
  const dateFormat = dateFormatRef
</script>

<style>
  body {
    background: rgb(16, 16, 16);
  }
</style>
