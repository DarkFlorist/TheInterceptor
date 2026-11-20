import * as funtypes from 'funtypes'
import type { GovernanceVoteInputParameters } from '../types/interceptor-messages.js'
import { EthereumAddress, EthereumData } from '../types/wire-types.js'
import { GovernorVoteAbi } from './abi.js'
import { decodeCallDataLoose } from './abiRuntime.js'
import { dataStringWith0xStart } from './bigint.js'
import { isAbiDataDecodeError } from './ethereumPrimitives.js'

const decodeVoteCall = (input: Uint8Array) => {
	try {
		return decodeCallDataLoose(GovernorVoteAbi, dataStringWith0xStart(input))
	} catch (error: unknown) {
		if (isAbiDataDecodeError(error)) return undefined
		throw error
	}
}

// Decodes a call to one of a governor's vote functions, or returns undefined for any other call data. The background and the confirmation window both identify votes through this, so they always agree on what a vote is.
export const decodeGovernanceVote = (input: Uint8Array): GovernanceVoteInputParameters | undefined => {
	const decoded = decodeVoteCall(input)
	if (decoded === undefined) return undefined
	const { proposalId, support, reason, params, signature, voter } = decoded.namedArgs
	return {
		proposalId: funtypes.BigInt.parse(proposalId),
		support: funtypes.Union(funtypes.Boolean, funtypes.BigInt).parse(support),
		reason: reason === undefined ? undefined : funtypes.String.parse(reason),
		params: params === undefined ? undefined : EthereumData.parse(params),
		signature: signature === undefined ? undefined : EthereumData.parse(signature),
		voter: voter === undefined ? undefined : EthereumAddress.parse(voter),
	}
}
