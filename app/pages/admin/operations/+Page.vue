<template>
  <n-flex vertical :size="24">
    <div>
      <h1 style="margin: 0; font-size: 24px; font-weight: 600">Operations</h1>
      <n-text depth="3">Capsule event streams, audit trails, promotion history, and rollback visibility.</n-text>
    </div>
    <n-card embedded size="small">
      <template #header>
        <n-text style="font-weight: 600">Operations surface coming next</n-text>
      </template>
      <n-text depth="3" style="font-size: 13px">
        This page will collect capsule lifecycle events, golden test outcomes, route alias promotion records, and rollback audit history.
      </n-text>
    </n-card>
  </n-flex>
</template>

<script setup lang="ts">
  import { NFlex, NText, NCard } from 'naive-ui'
</script>
