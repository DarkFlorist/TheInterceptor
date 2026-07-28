import * as funtypes from 'funtypes'
import { EthereumAddress, LiteralConverterParserFactory } from './wire-types.js'
const EtherscanSuccessStatus = funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'success' as const))
const EtherscanFailureStatus = funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'failure' as const))
const EtherscanFailureResult = funtypes.Object({
	status: EtherscanFailureStatus,
	result: funtypes.String,
}).asReadonly()

// Not full result definitions, only entries that we consume.
// https://docs.etherscan.io/api-reference/endpoint/getsourcecode
const EtherscanSourceCodeSuccessResult = funtypes.Object({
	status: EtherscanSuccessStatus,
	result: funtypes.ReadonlyTuple(funtypes.Object({
		ContractName: funtypes.String,
		ABI: funtypes.String,
		Proxy: funtypes.Union(funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'yes' as const)), funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'no' as const))),
		Implementation: funtypes.Union(funtypes.Literal(''), EthereumAddress)
	}))
}).asReadonly()
export type EtherscanSourceCodeResult = funtypes.Static<typeof EtherscanSourceCodeResult>
export const EtherscanSourceCodeResult = funtypes.Union(EtherscanSourceCodeSuccessResult, EtherscanFailureResult)

// https://docs.etherscan.io/api-reference/endpoint/getabi
const EtherscanGetABISuccessResult = funtypes.Object({
	status: EtherscanSuccessStatus,
	result: funtypes.String
}).asReadonly()
export type EtherscanGetABIResult = funtypes.Static<typeof EtherscanGetABIResult>
export const EtherscanGetABIResult = funtypes.Union(EtherscanGetABISuccessResult, EtherscanFailureResult)

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
