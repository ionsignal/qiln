import type { InstallAction } from '../../installation/journal/types'
import type { StepText } from '../aws/deployment/prepare/steps'

/**
 * `short` names the progress row and must fit the row label column (26
 * characters). `label` is the sentence that an approval screen lists.
 */
export const INSTALL_STEPS: Record<InstallAction, StepText> = {
  'materialize-checkout': {
    short: 'Clone source checkout',
    label: 'Clone the managed source checkout on the target',
  },
  'delete-image': {
    short: 'Delete previous image',
    label: 'Delete the previous managed image and its aliases',
  },
  'import-image': {
    short: 'Import orchestrator image',
    label: 'Upload and import the staged image without an alias',
  },
  'create-alias': {
    short: 'Create image alias',
    label: 'Point the managed image alias at the selected image',
  },
  'create-network': {
    short: 'Create managed network',
    label: 'Create the managed bridge network',
  },
  'create-volume': {
    short: 'Create PostgreSQL volume',
    label: 'Create the persistent PostgreSQL custom volume',
  },
  'create-instance': {
    short: 'Create orchestrator',
    label: 'Create the stopped orchestrator instance',
  },
  'update-instance': {
    short: 'Deliver credentials',
    label: 'Deliver the credentials to the stopped orchestrator instance',
  },
}
