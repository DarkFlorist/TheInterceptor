import * as funtypes from 'funtypes'

// Admission input for Safe review. Normalize transport data once, then persist the reviewed message or transaction in its domain model.
export type SafeMessageReview = funtypes.Static<typeof SafeMessageReview>
export const SafeMessageReview = funtypes.ReadonlyObject({ text: funtypes.String, isTypedData: funtypes.Boolean })

export type SafeReviewInput = funtypes.Static<typeof SafeReviewInput>
export const SafeReviewInput = funtypes.ReadonlyPartial({
	operation: funtypes.Union(funtypes.Literal(0), funtypes.Literal(1)),
	message: SafeMessageReview,
})
