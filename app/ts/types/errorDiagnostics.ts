import * as funtypes from 'funtypes'
import { EthereumTimestamp } from './wire-types.js'

export type InterceptorErrorCategory = funtypes.Static<typeof InterceptorErrorCategory>
export const InterceptorErrorCategory = funtypes.Union(
	funtypes.Literal('expected_infrastructure'),
	funtypes.Literal('external_service'),
	funtypes.Literal('local_recovery'),
	funtypes.Literal('unexpected'),
)

export type InterceptorErrorSeverity = funtypes.Static<typeof InterceptorErrorSeverity>
export const InterceptorErrorSeverity = funtypes.Union(
	funtypes.Literal('info'),
	funtypes.Literal('warning'),
	funtypes.Literal('error'),
)

export type InterceptorErrorDiagnostic = funtypes.Static<typeof InterceptorErrorDiagnostic>
export const InterceptorErrorDiagnostic = funtypes.ReadonlyObject({
	timestamp: EthereumTimestamp,
	source: funtypes.String,
	code: funtypes.String,
	category: InterceptorErrorCategory,
	severity: InterceptorErrorSeverity,
	message: funtypes.String,
	cause: funtypes.Union(funtypes.String, funtypes.Undefined),
	userVisible: funtypes.Boolean,
	debugId: funtypes.Union(funtypes.String, funtypes.Undefined),
	details: funtypes.Union(funtypes.String, funtypes.Undefined),
})
