import type { MockVaultDetail, FileEntry, MockFsNode } from '../types'
import { joinPath, getFileExtension } from './fileUtils'

const mockVaults: MockVaultDetail[] = [
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
    root: {
      type: 'directory',
      name: '/',
      modified: new Date().toISOString(),
      children: {
        'comfyui.log': {
          type: 'file',
          name: 'comfyui.log',
          modified: new Date().toISOString(),
          size: 512000,
          content: '[INFO] ComfyUI started successfully.\n[INFO] Loading custom nodes...\n[INFO] Loaded 45 nodes.',
        },
        'extra_model_paths.yaml': {
          type: 'file',
          name: 'extra_model_paths.yaml',
          modified: new Date(Date.now() - 86400000).toISOString(),
          size: 340,
          content: 'a1111:\n  base_path: /models/a1111\n  checkpoints: models/Stable-diffusion\n',
        },
        models: {
          type: 'directory',
          name: 'models',
          modified: new Date(Date.now() - 2000000).toISOString(),
          children: {
            checkpoints: {
              type: 'directory',
              name: 'checkpoints',
              modified: new Date(Date.now() - 5000000).toISOString(),
              children: {
                'sd_xl_base_1.0.safetensors': {
                  type: 'file',
                  name: 'sd_xl_base_1.0.safetensors',
                  modified: new Date(Date.now() - 10000000).toISOString(),
                  size: 6930000000,
                },
                'v1-5-pruned-emaonly.ckpt': {
                  type: 'file',
                  name: 'v1-5-pruned-emaonly.ckpt',
                  modified: new Date(Date.now() - 20000000).toISOString(),
                  size: 4270000000,
                },
                'dreamshaper_8.safetensors': {
                  type: 'file',
                  name: 'dreamshaper_8.safetensors',
                  modified: new Date(Date.now() - 15000000).toISOString(),
                  size: 2130000000,
                },
              },
            },
            loras: {
              type: 'directory',
              name: 'loras',
              modified: new Date(Date.now() - 8000000).toISOString(),
              children: {
                'add_detail.safetensors': {
                  type: 'file',
                  name: 'add_detail.safetensors',
                  modified: new Date(Date.now() - 9000000).toISOString(),
                  size: 144000000,
                },
                'lcm_lora_sdxl.safetensors': {
                  type: 'file',
                  name: 'lcm_lora_sdxl.safetensors',
                  modified: new Date(Date.now() - 12000000).toISOString(),
                  size: 396000000,
                },
              },
            },
            vae: {
              type: 'directory',
              name: 'vae',
              modified: new Date(Date.now() - 6000000).toISOString(),
              children: {
                'vae-ft-mse-840000-ema-pruned.safetensors': {
                  type: 'file',
                  name: 'vae-ft-mse-840000-ema-pruned.safetensors',
                  modified: new Date(Date.now() - 8000000).toISOString(),
                  size: 335000000,
                },
              },
            },
          },
        },
        custom_nodes: {
          type: 'directory',
          name: 'custom_nodes',
          modified: new Date(Date.now() - 1000000).toISOString(),
          children: {
            'ComfyUI-Manager': {
              type: 'directory',
              name: 'ComfyUI-Manager',
              modified: new Date(Date.now() - 1000000).toISOString(),
              children: {
                '__init__.py': {
                  type: 'file',
                  name: '__init__.py',
                  modified: new Date(Date.now() - 1000000).toISOString(),
                  size: 1024,
                  content: 'from .manager import *\n',
                },
                'requirements.txt': {
                  type: 'file',
                  name: 'requirements.txt',
                  modified: new Date(Date.now() - 1000000).toISOString(),
                  size: 45,
                  content: 'GitPython\nmatrix-client\n',
                },
              },
            },
            'ComfyUI-Impact-Pack': {
              type: 'directory',
              name: 'ComfyUI-Impact-Pack',
              modified: new Date(Date.now() - 1200000).toISOString(),
              children: {
                '__init__.py': {
                  type: 'file',
                  name: '__init__.py',
                  modified: new Date(Date.now() - 1200000).toISOString(),
                  size: 512,
                  content: '# Impact Pack Init\n',
                },
              },
            },
          },
        },
        input: {
          type: 'directory',
          name: 'input',
          modified: new Date().toISOString(),
          children: {
            'source_image_01.png': {
              type: 'file',
              name: 'source_image_01.png',
              modified: new Date(Date.now() - 3600000).toISOString(),
              size: 2400000,
            },
            'depth_map_01.jpg': {
              type: 'file',
              name: 'depth_map_01.jpg',
              modified: new Date(Date.now() - 4600000).toISOString(),
              size: 850000,
            },
          },
        },
        output: {
          type: 'directory',
          name: 'output',
          modified: new Date().toISOString(),
          children: {
            '2025-06-12': {
              type: 'directory',
              name: '2025-06-12',
              modified: new Date().toISOString(),
              children: {
                'ComfyUI_00001_.png': {
                  type: 'file',
                  name: 'ComfyUI_00001_.png',
                  modified: new Date(Date.now() - 1000).toISOString(),
                  size: 3100000,
                },
                'ComfyUI_00002_.png': {
                  type: 'file',
                  name: 'ComfyUI_00002_.png',
                  modified: new Date(Date.now() - 5000).toISOString(),
                  size: 3150000,
                },
              },
            },
          },
        },
        workflows: {
          type: 'directory',
          name: 'workflows',
          modified: new Date(Date.now() - 500000).toISOString(),
          children: {
            'sdxl_base_workflow.json': {
              type: 'file',
              name: 'sdxl_base_workflow.json',
              modified: new Date(Date.now() - 600000).toISOString(),
              size: 15400,
              content: '{"last_node_id": 15, "last_link_id": 22}',
            },
            'face_detailer.json': {
              type: 'file',
              name: 'face_detailer.json',
              modified: new Date(Date.now() - 700000).toISOString(),
              size: 28500,
              content: '{"last_node_id": 42, "last_link_id": 56}',
            },
          },
        },
      },
    },
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
    root: {
      type: 'directory',
      name: '/',
      modified: new Date().toISOString(),
      children: {
        notebooks: {
          type: 'directory',
          name: 'notebooks',
          modified: new Date().toISOString(),
          children: {
            'training_run_1.ipynb': {
              type: 'file',
              name: 'training_run_1.ipynb',
              modified: new Date(Date.now() - 86400000).toISOString(),
              size: 1024000,
              content: '{"cells": []}',
            },
            'data_cleaning.ipynb': {
              type: 'file',
              name: 'data_cleaning.ipynb',
              modified: new Date(Date.now() - 172800000).toISOString(),
              size: 512000,
              content: '{"cells": []}',
            },
          },
        },
        datasets: {
          type: 'directory',
          name: 'datasets',
          modified: new Date(Date.now() - 2000000).toISOString(),
          children: {
            'raw_data.csv': { type: 'file', name: 'raw_data.csv', modified: new Date(Date.now() - 3000000).toISOString(), size: 150000000 },
            'processed_data.parquet': {
              type: 'file',
              name: 'processed_data.parquet',
              modified: new Date(Date.now() - 1000000).toISOString(),
              size: 45000000,
            },
          },
        },
        'requirements.txt': {
          type: 'file',
          name: 'requirements.txt',
          modified: new Date(Date.now() - 500000).toISOString(),
          size: 120,
          content: 'torch==2.3.0\ntorchvision==0.18.0\npandas==2.2.2\n',
        },
      },
    },
  },
]

export function getVaultById(id: string): MockVaultDetail | null {
  return mockVaults.find(v => v.id === id) || null
}

function traversePath(root: MockFsNode, path: string): MockFsNode | null {
  if (path === '/' || path === '') return root
  const segments = path.split('/').filter(Boolean)
  let current = root
  for (const segment of segments) {
    if (current.type !== 'directory' || !current.children || !current.children[segment]) {
      return null
    }
    current = current.children[segment]
  }
  return current
}

export function resolveFileMetadata(vault: MockVaultDetail, path: string): MockFsNode | null {
  return traversePath(vault.root, path)
}

export function resolveDirectory(vault: MockVaultDetail, path: string): FileEntry[] {
  const node = traversePath(vault.root, path)
  if (!node || node.type !== 'directory' || !node.children) return []
  return Object.values(node.children).map(child => {
    const fullPath = joinPath(path, child.name)
    if (child.type === 'file') {
      return {
        type: 'file',
        path: fullPath,
        name: child.name,
        size: child.size || 0,
        modified: child.modified,
        extension: getFileExtension(child.name),
      }
    } else {
      return {
        type: 'directory',
        path: fullPath,
        name: child.name,
        modified: child.modified,
        childCount: child.children ? Object.keys(child.children).length : 0,
      }
    }
  })
}

export function resolveFileContent(vault: MockVaultDetail, path: string): string | null {
  const node = traversePath(vault.root, path)
  if (!node || node.type !== 'file') return null
  return node.content || null
}
