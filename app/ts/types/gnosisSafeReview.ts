import * as funtypes from 'funtypes'

// Admission input for Safe review. Normalize transport data once, then persist the reviewed message or transaction in its domain model.
export type GnosisSafeMessageReview = funtypes.Static<typeof GnosisSafeMessageReview>
export const GnosisSafeMessageReview = funtypes.ReadonlyObject({ text: funtypes.String, isTypedData: funtypes.Boolean })

export type GnosisSafeReviewInput = funtypes.Static<typeof GnosisSafeReviewInput>
export const GnosisSafeReviewInput = funtypes.ReadonlyPartial({
	operation: funtypes.Union(funtypes.Literal(0), funtypes.Literal(1)),
	message: GnosisSafeMessageReview,
})
