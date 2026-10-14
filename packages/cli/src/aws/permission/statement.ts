import { canonical } from '../json'
import { normalize } from './policy'

export type Conditions = Record<string, Record<string, string | string[]>>

export interface Statement {
  Effect: 'Allow'
  Action: string[]
  Resource: string | string[]
  Condition?: Conditions
}

export function allow(actions: string[], resources: string | string[], conditions?: Conditions): Statement {
  return {
    Effect: 'Allow',
    Action: actions.map(action => `ec2:${action}`),
    Resource: resources,
    ...(conditions === undefined ? {} : { Condition: conditions }),
  }
}

export function render(statements: Statement[]): string {
  return normalize(
    canonical({
      Version: '2012-10-17',
      Statement: statements,
    }),
  )
}
