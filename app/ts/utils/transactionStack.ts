import type { InterceptorStackOperation } from '../types/visualizer-types.js'

export function normalizeConsecutiveTimeManipulations(operations: readonly InterceptorStackOperation[]) {
	return operations.filter((operation, operationIndex) =>
		!(operationIndex > 0 && operation.type === 'TimeManipulation' && operations[operationIndex - 1]?.type === 'TimeManipulation')
	)
}
