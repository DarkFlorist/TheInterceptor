import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { bytesToHex, concat, formatUnits, getAddress, getCreate2Address, isAddress, keccak256, stringToBytes, toEventSelector, toFunctionSelector, toRlp } from '../../app/ts/utils/ethereumPrimitives.js'
import { stringToAddress } from '../../app/ts/utils/bigint.js'
import { checksumDeadAddress, invalidChecksumDeadAddress, lowercaseDeadAddress } from './ethereumPrimitivesFixtures.js'

describe('local Ethereum primitive helpers', () => {
	test('matches reference address, bytes, RLP, selector, and unit formatting vectors', () => {
		assert.equal(getAddress(lowercaseDeadAddress), checksumDeadAddress)
		assert.equal(getAddress('0x000000000000000000000000000000000000DEAD'), checksumDeadAddress)
		assert.equal(getAddress(invalidChecksumDeadAddress), checksumDeadAddress)
		assert.throws(() => getAddress('0x1234'), /invalid/u)
		assert.equal(isAddress(checksumDeadAddress), true)
		assert.equal(isAddress(lowercaseDeadAddress), true)
		assert.equal(isAddress('0x000000000000000000000000000000000000DEAD'), true)
		assert.equal(isAddress('0X000000000000000000000000000000000000DEAD'), false)
		assert.equal(isAddress(invalidChecksumDeadAddress), false)
		assert.equal(isAddress('0xDE709F2102306220921060314715629080E2FB77'), true)
		assert.equal(stringToAddress('0xDE709F2102306220921060314715629080E2FB77'), 0xde709f2102306220921060314715629080e2fb77n)
		assert.equal(
			getCreate2Address({
				from: checksumDeadAddress,
				salt: `0x${ '00'.repeat(31) }2a`,
				bytecodeHash: keccak256('0x60006000'),
			}),
			'0x82774b0268C8ED297E610841C83B862FDB78673b',
		)
		assert.equal(bytesToHex(new Uint8Array([0, 1, 255])), '0x0001ff')
		assert.equal(bytesToHex(stringToBytes('hello')), '0x68656c6c6f')
		assert.equal(keccak256(stringToBytes('hello')), '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8')
		assert.equal(concat(['0x12', '0x3456']), '0x123456')
		assert.throws(() => Reflect.apply(concat, undefined, [['0x12', new Uint8Array([0x34])]]), /Cannot concat hex strings and byte arrays/u)
		assert.equal(toRlp(['0x01', ['0x02', '0x636174']], 'hex'), '0xc701c50283636174')
		assert.deepStrictEqual(toRlp(['0x01', ['0x02', '0x636174']], 'bytes'), new Uint8Array([0xc7, 0x01, 0xc5, 0x02, 0x83, 0x63, 0x61, 0x74]))
		assert.throws(() => toRlp(0), /RLP value/u)
		assert.throws(() => toRlp('cat'), /0x-prefixed/u)
		assert.throws(() => toRlp([1, 2, '0x03']), /RLP value/u)
		assert.equal(toFunctionSelector('transfer(address,uint256)'), '0xa9059cbb')
		assert.equal(toEventSelector('Transfer(address,address,uint256)'), '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
		assert.equal(formatUnits(1234567890000000000n, 18), '1.23456789')
		assert.equal(formatUnits(-120000n, 4), '-12')
	})
})
