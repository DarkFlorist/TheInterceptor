import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import * as funtypes from 'funtypes'
import { EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'

// An intersection whose second member is a union, like the forwarded wallet requests in RPCReply.
const ForwardedRequest = funtypes.Intersect(
	funtypes.ReadonlyObject({ type: funtypes.Literal('forward') }),
	funtypes.Union(
		funtypes.ReadonlyObject({ method: funtypes.Literal('eth_sign'), params: funtypes.String }),
		funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBalance'), params: EthereumQuantity }),
	),
)

describe('serialize wire types', () => {
	test('keeps union members of an intersection as alternatives', () => {
		const wire = serialize<funtypes.Static<typeof ForwardedRequest>, typeof ForwardedRequest>(ForwardedRequest, { type: 'forward', method: 'eth_getBalance', params: 5n })
		// These annotations only compile while the wire type is { type: 'forward' } & ({ method: 'eth_sign', … } | { method: 'eth_getBalance', params: string }); intersecting every member flattened it to never.
		const expectedWire: typeof wire = { type: 'forward', method: 'eth_getBalance', params: '0x5' }
		const otherMethod: typeof wire.method = 'eth_sign'
		assert.deepEqual(wire, expectedWire)
		assert.notEqual(wire.method, otherMethod)
	})
})
