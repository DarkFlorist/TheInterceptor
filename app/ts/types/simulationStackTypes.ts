import * as funtypes from 'funtypes'
import { BytesParser, EthereumAddress, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity, EthereumUnsignedTransaction, LiteralConverterParserFactory } from './wire-types.js'
import { SimulatedTransaction } from './visualizer-types.js'
import { EthBalanceChanges } from './JsonRpc-types.js'
import { StateOverrides } from './ethSimulate-types.js'

const RevertErrorParser: funtypes.ParsedValue<funtypes.String, string>['config'] = {
	parse: (value) => {
		if (!value.startsWith('Reverted ')) return { success: true, value }
		const parseResult = BytesParser.parse(value.slice('Reverted '.length))
		if (!parseResult.success) return parseResult
		const decoded = new TextDecoder().decode(parseResult.value)
		return { success: true, value: decoded }
	},
	serialize: (value) => {
		const encoded = new TextEncoder().encode(value)
		const serializationResult = BytesParser.serialize!(encoded)
		if (!serializationResult.success) return serializationResult
		return { success: true, value: `Reverted ${ serializationResult.value }` }
	}
}

type OldMulticallLog = funtypes.Static<typeof OldMulticallLog>
const OldMulticallLog = funtypes.Object({
	loggersAddress: EthereumAddress,
	data: EthereumInput,
	topics: funtypes.ReadonlyArray(EthereumBytes32),
}).asReadonly()

export type GetSimulationStackOldReply = funtypes.Static<typeof GetSimulationStackOldReply>
export const GetSimulationStackOldReply = funtypes.ReadonlyArray(
	funtypes.Intersect(
		EthereumUnsignedTransaction,
		funtypes.Union(
			funtypes.Object({
				statusCode: funtypes.Literal(1).withParser(LiteralConverterParserFactory(1, 'success' as const)),
				gasSpent: EthereumQuantity,
				returnValue: EthereumData,
				events: funtypes.ReadonlyArray(OldMulticallLog),
				balanceChanges: EthBalanceChanges,
			}).asReadonly(),
			funtypes.Object({
				statusCode: funtypes.Literal(0).withParser(LiteralConverterParserFactory(0, 'failure' as const)),
				gasSpent: EthereumQuantity,
				error: funtypes.String.withParser(RevertErrorParser),
				returnValue: EthereumData,
			}).asReadonly()
		),
		funtypes.Object({
			realizedGasPrice: EthereumQuantity,
			gasLimit: EthereumQuantity,
			maxPriorityFeePerGas: EthereumQuantity,
			balanceChanges: EthBalanceChanges
		}).asReadonly()
	)
)

export type GetSimulationStackReply = funtypes.Static<typeof GetSimulationStackReply>
export const GetSimulationStackReply = funtypes.ReadonlyObject({ 
	stateOverrides: StateOverrides,
	transactions: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ simulatedTransaction: SimulatedTransaction, ethBalanceChanges: EthBalanceChanges }).asReadonly())
})
