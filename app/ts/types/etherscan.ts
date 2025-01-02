import * as funtypes from 'funtypes'
import { EthereumAddress, LiteralConverterParserFactory } from './wire-types.js'
// Not full result definition, only entries that we consume
// https://docs.etherscan.io/api-endpoints/contracts#get-contract-source-code-for-verified-contract-source-codes
export type EtherscanSourceCodeResult = funtypes.Static<typeof EtherscanSourceCodeResult>
export const EtherscanSourceCodeResult = funtypes.Object({
	status: funtypes.Union(funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'success' as const)), funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'failure' as const))),
	result: funtypes.ReadonlyTuple(funtypes.Object({
		ContractName: funtypes.String,
		ABI: funtypes.String,
		Proxy: funtypes.Union(funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'yes' as const)), funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'no' as const))),
		Implementation: funtypes.Union(funtypes.Literal(''), EthereumAddress)
	}))
}).asReadonly()

// Not full result definition, only entries that we consume
// https://docs.etherscan.io/api-endpoints/contracts#get-contract-abi-for-verified-contract-source-codes
export type EtherscanGetABIResult = funtypes.Static<typeof EtherscanGetABIResult>
export const EtherscanGetABIResult = funtypes.Object({
	status: funtypes.Union(funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'success' as const)), funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'failure' as const))),
	result: funtypes.String
}).asReadonly()

export type SourcifyMetadataResult = funtypes.Static<typeof SourcifyMetadataResult>
export const SourcifyMetadataResult = funtypes.Object({
	compiler: funtypes.Unknown,
	language: funtypes.Unknown,
	output: funtypes.Object({
		abi: funtypes.Array(funtypes.Unknown)
	}),
	settings: funtypes.Unknown,
	sources: funtypes.Unknown,
	version: funtypes.Unknown,
}).asReadonly()
