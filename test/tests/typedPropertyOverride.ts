import { replaceProperty } from '../harness/globals.js'

// Replaces one property of an object, including readonly instance members such as EthereumClientService's arrow-function methods, with a value of the property's own type; returns the restore function.
export const overrideProperty = <Target extends object, Key extends keyof Target>(target: Target, key: Key, value: Target[Key]) => replaceProperty(target, key, value)
