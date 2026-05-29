<template>
  <div class="workspace-wrapper">
    <div class="workspace-scroll-area">
      <n-flex vertical :size="24">
        <n-flex justify="space-between" align="center">
          <div>
            <h1 style="margin: 0; font-size: 24px; font-weight: 600">Storage Vaults</h1>
            <n-text depth="3">Your provisioned ZFS storage volumes.</n-text>
          </div>
          <n-button type="primary" size="small" color="white" strong>Create Vault</n-button>
        </n-flex>
        <div v-if="mockVaults.length === 0">
          <n-empty description="No vaults provisioned." style="margin-top: 48px" />
        </div>
        <div v-else class="vault-grid">
          <vault-card
            v-for="vault in mockVaults"
            :key="vault.id"
            :vault="vault"
            :selected="selectedVaultId === vault.id"
            @select="selectedVaultId = vault.id"
            @inspect="handleInspect(vault.id)"
            @browse="handleBrowse(vault.id)"
            @snapshot="handleSnapshot(vault.id)" />
        </div>
      </n-flex>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { ref } from 'vue'
  import { NFlex, NText, NButton, NEmpty } from 'naive-ui'
  import { VaultCard } from '@qiln/engine/client'
  import type { WorkspaceVault } from '@qiln/engine/client'
  import { navigate } from 'vike/client/router'

  const selectedVaultId = ref<string | null>(null)
  const mockVaults = ref<WorkspaceVault[]>([
    {
      id: 'comfy-workspace-data',
      name: 'comfy-workspace-data',
      type: 'empty',
      status: 'healthy',
      usedGB: 142,
      totalGB: 200,
      attachedVessel: { name: 'comfy-workspace', id: 'comfy-workspace' },
      mountPath: '/workspace',
      pool: 'is-nvme-pool',
      lastSnapshotAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      createdAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    },
    {
      id: 'comfy-workspace-models',
      name: 'comfy-workspace-models',
      type: 'clone',
      status: 'healthy',
      usedGB: 87,
      totalGB: 100,
      attachedVessel: { name: 'comfy-workspace', id: 'comfy-workspace' },
      mountPath: '/models',
      pool: 'is-nvme-pool',
      lastSnapshotAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
      createdAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    },
    {
      id: 'research-jupyter-notebooks',
      name: 'research-jupyter-notebooks',
      type: 'empty',
      status: 'healthy',
      usedGB: 12.6,
      totalGB: 20,
      attachedVessel: { name: 'research-jupyter', id: 'research-jupyter' },
      mountPath: '/home/jovyan/notebooks',
      pool: 'is-nvme-pool',
      lastSnapshotAt: null,
      createdAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    },
    {
      id: 'prod-vllm-models',
      name: 'prod-vllm-01-models',
      type: 'clone',
      status: 'snapshotting',
      usedGB: 87.3,
      totalGB: 100,
      attachedVessel: { name: 'prod-vllm-01', id: 'prod-vllm-01' },
      mountPath: '/models',
      pool: 'is-nvme-pool',
      lastSnapshotAt: new Date(Date.now() - 12 * 3_600_000).toISOString(),
      createdAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    },
    {
      id: 'staging-data-scratch',
      name: 'staging-data-scratch',
      type: 'empty',
      status: 'healthy',
      usedGB: 0,
      totalGB: 50,
      attachedVessel: null,
      mountPath: null,
      pool: 'is-nvme-pool',
      lastSnapshotAt: null,
      createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    },
    {
      id: 'db-pgdata',
      name: 'database-node-pgdata',
      type: 'empty',
      status: 'error',
      usedGB: 48.1,
      totalGB: 50,
      attachedVessel: { name: 'database-node', id: 'database-node' },
      mountPath: '/var/lib/postgresql/data',
      pool: 'is-nvme-pool',
      lastSnapshotAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    },
    {
      id: 'training-datasets',
      name: 'training-datasets',
      type: 'clone',
      status: 'healthy',
      usedGB: 340,
      totalGB: 500,
      attachedVessel: { name: 'research-jupyter', id: 'research-jupyter' },
      mountPath: '/datasets',
      pool: 'is-nvme-pool',
      lastSnapshotAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      createdAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
    },
  ])

  function handleInspect(id: string) {
    selectedVaultId.value = id
    console.log(`[Vaults] Inspect vault: ${id}`)
  }

  function handleBrowse(id: string) {
    navigate(`/admin/workspace/vaults/${id}`)
  }

  function handleSnapshot(id: string) {
    const vault = mockVaults.value.find(v => v.id === id)
    if (!vault || vault.status === 'snapshotting') return
    // Simulate snapshot lifecycle
    vault.status = 'snapshotting'
    setTimeout(() => {
      vault.status = 'healthy'
      vault.lastSnapshotAt = new Date().toISOString()
    }, 3000)
  }
</script>

<style scoped>
  .workspace-wrapper {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .workspace-scroll-area {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
  }

  .vault-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(318px, 1fr));
    transition: opacity 0.3s ease;
  }

  .grid-dimmed {
    opacity: 0.6;
  }
</style>
