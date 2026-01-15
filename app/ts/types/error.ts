import * as funtypes from 'funtypes'

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
