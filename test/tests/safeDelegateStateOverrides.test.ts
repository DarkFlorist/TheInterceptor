import * as assert from 'node:assert'
import { test } from 'bun:test'
import { ORIGINAL_GNOSIS_SAFE, prepareSafeDelegateStateOverrides } from '../../app/ts/safe/safeSimulation.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { getGnosisSafeProxyProxy } from '../../app/ts/utils/ethereumByteCodes.js'
import type { StateOverrides } from '../../app/ts/types/ethSimulate-types.js'

test('Safe delegate redirection preserves account overrides without mutating the input', () => {
	const safeAddress = 0x1234n
	const safe = addressString(safeAddress)
	const original = addressString(ORIGINAL_GNOSIS_SAFE)
	const other = addressString(0x5678n)
	const code = new Uint8Array([0x60, 0x01])
	const overrides: StateOverrides = {
		[safe]: { balance: 42n, nonce: 3n, stateDiff: { '0x00': 7n }, code: new Uint8Array([1]) },
		[original]: { balance: 8n, state: { '0x01': 9n }, code: new Uint8Array([2]) },
		[other]: { balance: 10n, code: new Uint8Array([3]) },
	}
	const before = structuredClone(overrides)
	const prepared = prepareSafeDelegateStateOverrides(safeAddress, code, overrides)
	assert.deepEqual(prepared, {
		...before,
		[safe]: { ...before[safe], code: getGnosisSafeProxyProxy() },
		[original]: { ...before[original], code },
	})
	assert.deepEqual(overrides, before)
	assert.deepEqual(prepareSafeDelegateStateOverrides(safeAddress, code), {
		[safe]: { code: getGnosisSafeProxyProxy() },
		[original]: { code },
	})
})
