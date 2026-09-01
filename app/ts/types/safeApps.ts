import * as funtypes from 'funtypes'

export type SafeAppsRequestCommand = funtypes.Static<typeof SafeAppsRequestCommand>
export const SafeAppsRequestCommand = funtypes.Union(
	funtypes.ReadonlyObject({ kind: funtypes.Literal('result'), value: funtypes.Unknown }),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('ethereumRequest'),
		method: funtypes.String,
		params: funtypes.ReadonlyArray(funtypes.Unknown),
		mapResult: funtypes.Union(funtypes.Literal('passthrough'), funtypes.Literal('safeTxHash')),
	}),
)
