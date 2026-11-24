export const watchAssetRequestError = (message: string, code = -32602) => ({
	type: 'result' as const,
	method: 'wallet_watchAsset' as const,
	error: { code, message },
})

export const invalidWatchAssetRequest = (message: string) => watchAssetRequestError(message)
