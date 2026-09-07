import * as funtypes from 'funtypes'

type JsonObject = { readonly [key: string]: JsonValue }
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject
export const JsonValue: funtypes.Runtype<JsonValue> = funtypes.Lazy(() => funtypes.Union(
	funtypes.String,
	funtypes.Number.withConstraint(Number.isFinite),
	funtypes.Boolean,
	funtypes.Null,
	funtypes.ReadonlyArray(JsonValue),
	funtypes.ReadonlyRecord(funtypes.String, JsonValue).withGuard<JsonObject>((value): value is JsonObject => Object.values(value).every((entry) => entry !== undefined)),
))

export type SafeAppsRequestCommand = funtypes.Static<typeof SafeAppsRequestCommand>
export const SafeAppsRequestCommand = funtypes.Union(
	funtypes.ReadonlyObject({ kind: funtypes.Literal('settings'), offChainSigning: funtypes.Boolean }),
	funtypes.ReadonlyObject({ kind: funtypes.Literal('result'), value: JsonValue }),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('ethereumRequest'),
		method: funtypes.String,
		params: funtypes.ReadonlyArray(JsonValue),
	}).And(funtypes.Union(
		funtypes.ReadonlyObject({ mapResult: funtypes.Union(funtypes.Literal('passthrough'), funtypes.Literal('safeTxHash')) }),
		funtypes.ReadonlyObject({ mapResult: funtypes.Literal('safeMessage'), message: funtypes.String, safeAddress: funtypes.String, chainId: funtypes.String }).And(funtypes.ReadonlyPartial({ isTypedData: funtypes.Boolean })),
	)),
)
