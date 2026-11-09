import * as assert from 'assert'
import { test } from 'bun:test'
import { getCurvesVersionCouplingErrors } from '../../scripts/check-curves-version.mts'

const singleCopyLockfile = '"@noble/curves": ["@noble/curves@2.2.0", "", {}],\n"micro-eth-signer/@noble/hashes": ["@noble/hashes@2.2.0", "", {}],'

test('the @noble/curves coupling lint accepts a pin equal to micro-eth-signer\'s dependency with one installed copy', () => {
	assert.deepEqual(getCurvesVersionCouplingErrors({ pinnedVersion: '2.2.0', requiredVersion: '2.2.0', lockfile: singleCopyLockfile }), [])
})

test('the @noble/curves coupling lint names the required version when micro-eth-signer moves to another one', () => {
	const [error] = getCurvesVersionCouplingErrors({ pinnedVersion: '2.2.0', requiredVersion: '2.3.0', lockfile: singleCopyLockfile })
	assert.match(error ?? '', /pins @noble\/curves 2\.2\.0, but micro-eth-signer depends on 2\.3\.0: set exactly 2\.3\.0/u)
})

test('the @noble/curves coupling lint rejects a second copy nested under micro-eth-signer and a dropped dependency', () => {
	assert.equal(getCurvesVersionCouplingErrors({ pinnedVersion: '2.2.0', requiredVersion: '2.2.0', lockfile: `${ singleCopyLockfile }\n"micro-eth-signer/@noble/curves": ["@noble/curves@2.3.0", "", {}],` }).length, 1)
	assert.equal(getCurvesVersionCouplingErrors({ pinnedVersion: '2.2.0', requiredVersion: undefined, lockfile: singleCopyLockfile }).length, 1)
})
