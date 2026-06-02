import { ens_normalize } from './viem.js'
import { tryOrUndefined } from './try.js'

export const normalizeEnsNameOrUndefined = (name: string) =>
	tryOrUndefined(
		() => ens_normalize(name),
		(error) => error instanceof Error,
	)

export const isValidEnsName = (name: string) => normalizeEnsNameOrUndefined(name) !== undefined
