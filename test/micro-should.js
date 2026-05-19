import { describe as bunDescribe, test } from 'bun:test'

export const describe = bunDescribe
export const should = (name, fn) => test(name, fn)
export const run = async () => undefined
export const runIfRoot = async (fn, _meta) => {
	await fn()
}
