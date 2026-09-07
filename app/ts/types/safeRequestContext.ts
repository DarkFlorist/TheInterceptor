import * as funtypes from 'funtypes'

// Interceptor review context travels beside RPC params; none of these fields are part of an Ethereum payload.
export type SafeMessageReview = funtypes.Static<typeof SafeMessageReview>
export const SafeMessageReview = funtypes.ReadonlyObject({ text: funtypes.String, isTypedData: funtypes.Boolean })

export type SafeRequestContext = funtypes.Static<typeof SafeRequestContext>
export const SafeRequestContext = funtypes.ReadonlyPartial({
	operation: funtypes.Union(funtypes.Literal(0), funtypes.Literal(1)),
	message: SafeMessageReview,
})
