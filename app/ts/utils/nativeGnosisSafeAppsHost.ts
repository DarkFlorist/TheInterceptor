import { parseGnosisSafeAppsRequest, parseGnosisSafeAppsResponse, isGnosisSafeAppsDiscoveryMethod, type GnosisSafeAppsRequest, type GnosisSafeAppsResponse } from '../../shared/ts/gnosisSafeAppsProtocol.js'
import { getHtmlPageUrl } from './htmlPages.js'
export { GNOSIS_SAFE_APPS_RESPONSE_VERSION, GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT, createGnosisSafeAppsErrorResponse } from '../../shared/ts/gnosisSafeAppsProtocol.js'

export type NativeGnosisSafeAppsRequest = GnosisSafeAppsRequest
export type NativeGnosisSafeAppsResponse = GnosisSafeAppsResponse

export type NativeGnosisSafeAppsLaunch = { readonly hostTabId: number, readonly appUrl: URL }

// Discovery can be superseded when settings change. Every other request is retained conservatively until its terminal reply, including methods added by a newer SDK.
export const isNativeGnosisSafeAppsDiscovery = isGnosisSafeAppsDiscoveryMethod

// The native iframe never receives the private token used between the original tab's two script worlds.
export function parseNativeGnosisSafeAppsRequest(value: unknown): NativeGnosisSafeAppsRequest | undefined {
	const parsed = parseGnosisSafeAppsRequest(value)
	if (parsed === undefined || !('request' in parsed)) return undefined
	return parsed.request
}

export function parseNativeGnosisSafeAppsResponse(value: unknown): NativeGnosisSafeAppsResponse | undefined {
	return parseGnosisSafeAppsResponse(value)
}

const invalidNativeGnosisSafeAppsLaunch = (message: string) => Object.assign(new Error(message), { code: 'native_gnosis_safe_apps_launch_invalid' })

export const isNativeGnosisSafeAppsLaunchValidationError = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'native_gnosis_safe_apps_launch_invalid'

export function parseNativeGnosisSafeAppsLaunch(parameters: URLSearchParams): NativeGnosisSafeAppsLaunch {
	const tabParameter = parameters.get('hostTabId')
	const appParameter = parameters.get('appUrl')
	if (tabParameter === null || !/^[0-9]+$/.test(tabParameter) || !Number.isSafeInteger(Number(tabParameter))) throw invalidNativeGnosisSafeAppsLaunch('The app host tab is missing or invalid. Open the app from the Interceptor popup.')
	if (appParameter === null) throw invalidNativeGnosisSafeAppsLaunch('The Gnosis Safe App URL is missing. Open the app from the Interceptor popup.')
	let appUrl: URL
	try { appUrl = new URL(appParameter) } catch (error: unknown) {
		if (!(error instanceof TypeError)) throw error
		throw invalidNativeGnosisSafeAppsLaunch('The Gnosis Safe App URL is invalid. Open the app from the Interceptor popup.')
	}
	if ((appUrl.protocol !== 'https:' && appUrl.protocol !== 'http:') || appUrl.username !== '' || appUrl.password !== '') throw invalidNativeGnosisSafeAppsLaunch('Gnosis Safe Apps must use an HTTP or HTTPS URL without embedded credentials.')
	return { hostTabId: Number(tabParameter), appUrl }
}

export function nativeGnosisSafeAppsHostUrl(extensionRoot: string, hostTabId: number, appUrl: string, manifestVersion = browser.runtime.getManifest().manifest_version) {
	const parameters = new URLSearchParams({ hostTabId: String(hostTabId), appUrl })
	parseNativeGnosisSafeAppsLaunch(parameters)
	return `${ getHtmlPageUrl('gnosisSafeAppsHost', extensionRoot, manifestVersion) }?${ parameters }`
}
