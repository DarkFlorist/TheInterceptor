import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { SIMULATION_NATIVE_TOKEN, SIMULATION_NATIVE_TOKEN_ADDRESS } from '../../app/shared/ts/simulationNativeToken.js'
import { SIMULATION_NATIVE_TOKEN_ADDRESS as policyAddress } from '../../app/shared/ts/siteBehaviorPolicy.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'

test('simulation logs and HTTP overlays derive native currency identity from one owner', () => {
	assert.match(SIMULATION_NATIVE_TOKEN_ADDRESS, /^0x[0-9a-f]{40}$/u)
	assert.equal(ETHEREUM_LOGS_LOGGER_ADDRESS, SIMULATION_NATIVE_TOKEN)
	assert.equal(BigInt(SIMULATION_NATIVE_TOKEN_ADDRESS), ETHEREUM_LOGS_LOGGER_ADDRESS)
	assert.equal(policyAddress, SIMULATION_NATIVE_TOKEN_ADDRESS)
})
