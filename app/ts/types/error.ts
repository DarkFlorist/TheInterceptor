import * as funtypes from 'funtypes'

export type ErrorWithCodeAndOptionalData = funtypes.Static<typeof ErrorWithCodeAndOptionalData>
export const ErrorWithCodeAndOptionalData = funtypes.Intersect(
	funtypes.ReadonlyObject({
		code: funtypes.Number,
		message: funtypes.String,
	}),
	// JSON-RPC lets providers return any JSON value as error data (for example Infura's -32005 rate-limit object), so consumers must narrow it; revert decoding only applies to hex-string data.
	funtypes.Partial({
		data: funtypes.Unknown
	})
)

export type DecodedError = funtypes.Static<typeof DecodedError>
export const DecodedError = funtypes.Intersect(
	ErrorWithCodeAndOptionalData,
	funtypes.ReadonlyObject({ decodedErrorMessage: funtypes.String })
)
