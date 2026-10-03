// Shared by Safe admission, confirmation, and the injected transport. Keep this module browser-independent.
export const SAFE_APPS_REQUEST_METHOD = 'safe_apps_request'
export const SAFE_EXECUTION_METHOD = 'eth_sendTransaction'
export const SAFE_SIGNATURE_METHOD = 'eth_signTypedData_v4'

export function isSafeSignerMethodTranslation(requestMethod: string, signerMethod: string): boolean {
	if (requestMethod === SAFE_APPS_REQUEST_METHOD) return signerMethod === SAFE_EXECUTION_METHOD || signerMethod === SAFE_SIGNATURE_METHOD
	return signerMethod === SAFE_SIGNATURE_METHOD && (requestMethod === SAFE_EXECUTION_METHOD || requestMethod === 'personal_sign')
}
