// Host presentation/cache policy, separate from SDK request deadlines. Refresh normally renews metadata before cache expiry; the handshake warning never expires an admitted request.
export const NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING = {
	handshakeTimeoutMs: 15_000,
	preparedMetadataLifetimeMs: 10_000,
	metadataRefreshIntervalMs: 5_000,
} as const
