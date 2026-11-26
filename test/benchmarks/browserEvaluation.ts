// Both transports evaluate one expression, await its result, and carry the same JSON value rather than exposing engine-specific remote object representations.
export const browserEvaluationExpression = (expression: string) => `(async () => JSON.stringify(await (${ expression })))()`

export function parseBrowserEvaluationValue<T>(serialized: unknown): T | undefined {
	if (serialized === undefined) return undefined
	if (typeof serialized !== 'string') throw new Error('Browser evaluation did not return serialized JSON')
	const value: T = JSON.parse(serialized)
	return value
}
