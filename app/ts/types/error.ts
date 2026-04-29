import * as funtypes from 'funtypes'

export type ForwardedErrorSource = funtypes.Static<typeof ForwardedErrorSource>
export const ForwardedErrorSource = funtypes.Union(
	funtypes.Literal('inpage'),
	funtypes.Literal('content-script'),
	funtypes.Literal('document-start'),
)

export type ForwardedDiagnostics = funtypes.Static<typeof ForwardedDiagnostics>
export const ForwardedDiagnostics = funtypes.Intersect(
	funtypes.ReadonlyObject({
		source: ForwardedErrorSource,
		phase: funtypes.String,
		message: funtypes.String,
	}),
	funtypes.ReadonlyPartial({
		name: funtypes.String,
		stack: funtypes.String,
		code: funtypes.Number,
		data: funtypes.String,
		cause: funtypes.String,
		requestId: funtypes.Number,
		requestMethod: funtypes.String,
		raw: funtypes.String,
	}),
)

export type ErrorWithCodeAndOptionalData = funtypes.Static<typeof ErrorWithCodeAndOptionalData>
export const ErrorWithCodeAndOptionalData = funtypes.Intersect(
	funtypes.ReadonlyObject({
		code: funtypes.Number,
		message: funtypes.String,
	}),
	funtypes.Partial({
		data: funtypes.String
	})
)

export type DecodedError = funtypes.Static<typeof DecodedError>
export const DecodedError = funtypes.Intersect(
	ErrorWithCodeAndOptionalData,
	funtypes.ReadonlyObject({ decodedErrorMessage: funtypes.String })
)
