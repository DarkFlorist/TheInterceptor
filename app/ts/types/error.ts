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

// Errors displayed by the Interceptor retain their raw RPC data and may carry a deliberate explanation from the code that diagnosed the failure. Plain RPC/simulation errors carry no explanation; creation failures can carry balance-shortfall or Safe GS013 explanations. Optional fields keep older stored errors compatible.
export type ErrorWithOptionalExplanation = funtypes.Static<typeof ErrorWithOptionalExplanation>
export const ErrorWithOptionalExplanation = funtypes.Intersect(
	ErrorWithCodeAndOptionalData,
	funtypes.ReadonlyPartial({ insufficientBalanceMessage: funtypes.String, safeCallRevertedMessage: funtypes.String })
)

// Transaction creation uses the same error contract as the shared display policy, with no second schema or conversion.
export type TransactionCreationError = ErrorWithOptionalExplanation
export const TransactionCreationError = ErrorWithOptionalExplanation
