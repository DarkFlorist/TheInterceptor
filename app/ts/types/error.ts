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

// Keeps the raw RPC error because getTransactionCreationFailureReason derives the displayed reason when the confirmation visualisation is built, where the ABIs are known. insufficientBalanceMessage (balance shortfalls) and safeCallRevertedMessage (a Gnosis Safe's GS013) are deliberate overrides of that reason, written by the code that diagnosed the failure, and are optional so failures stored before they existed still parse.
export type TransactionCreationError = funtypes.Static<typeof TransactionCreationError>
export const TransactionCreationError = funtypes.Intersect(
	ErrorWithCodeAndOptionalData,
	funtypes.ReadonlyPartial({ insufficientBalanceMessage: funtypes.String, safeCallRevertedMessage: funtypes.String })
)
