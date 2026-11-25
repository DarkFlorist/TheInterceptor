// Type-checked by settingsSnapshotProjections.test.ts: each line marked `expect-type-error` must fail to compile, and nothing else in the file may.
import { type SettingsSnapshot, requireSettingsWithReadableNetwork } from '../../../app/ts/background/settings.js'
import { type ReadyRpcSettings, settingsIfRpcConfigurationReady } from '../../../app/ts/background/rpcReadySettings.js'

export async function projections(snapshot: SettingsSnapshot) {
	const ready: ReadyRpcSettings | undefined = settingsIfRpcConfigurationReady(snapshot)
	const readable: ReadyRpcSettings | undefined = snapshot.status === 'active-network-readable' ? snapshot.settings : undefined // expect-type-error
	const required: ReadyRpcSettings = await requireSettingsWithReadableNetwork() // expect-type-error
	return [ready, readable, required]
}
