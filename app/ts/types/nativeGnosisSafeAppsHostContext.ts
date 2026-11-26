import * as funtypes from 'funtypes'

export const NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT = 'native_gnosis_safe_apps_host_context'

export const NativeGnosisSafeAppsHostContextChange = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('context-changed'), keys: funtypes.ReadonlyArray(funtypes.String) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('source-disconnected') }),
)
export type NativeGnosisSafeAppsHostContextChange = funtypes.Static<typeof NativeGnosisSafeAppsHostContextChange>
