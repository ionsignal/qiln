import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// Register the custom loader
register('./loader.mjs', pathToFileURL('./'))
