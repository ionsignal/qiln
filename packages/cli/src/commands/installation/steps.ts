import type { InstallAction } from '../../installation/journal/types'
import type { StartupAction } from '../../installation/startup/types'
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
    short: 'Deliver instance config',
    label: 'Deliver the credentials, published ports, and ingress configuration to the stopped orchestrator instance',
  },
}

export const START_STEPS: Record<StartupAction, StepText> = {
  'start-instance': {
    short: 'Start orchestrator',
    label: 'Start the orchestrator instance and wait for its guest prerequisites',
  },
  install: {
    short: 'Install dependencies',
    label: 'Install the checkout dependencies in the orchestrator',
  },
  build: {
    short: 'Build development outputs',
    label: 'Build the package and SSH authority development outputs',
  },
  migrate: {
    short: 'Migrate database',
    label: 'Apply the database migrations to the persistent PostgreSQL volume',
  },
  grant: {
    short: 'Apply database grants',
    label: 'Apply the SSH role privileges to the database',
  },
  'create-admin': {
    short: 'Create administrator',
    label: 'Create the first administrator from the one-shot credentials file',
  },
  'start-services': {
    short: 'Start services',
    label: 'Start the SSH authority and the Web server with its embedded Worker',
  },
}
