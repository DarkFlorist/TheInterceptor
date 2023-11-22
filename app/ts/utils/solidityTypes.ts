import { assertNever } from './typescript.js'
import { EthereumAddress, EthereumData, NonHexBigInt } from '../types/wire-types.js'
import * as funtypes from 'funtypes'
import { identifyAddress } from '../background/metadataUtils.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { UserAddressBook } from '../types/addressBookTypes.js'
import { EnrichedGroupedSolidityType, PureGroupedSolidityType, SolidityType } from '../types/solidityType.js'

function getSolidityTypeCategory(type: SolidityType) {
	switch(type) {
		case 'uint8': 
		case 'uint16': 
		case 'uint24': 
		case 'uint32': 
		case 'uint40': 
		case 'uint48': 
		case 'uint56': 
		case 'uint64': 
		case 'uint72': 
		case 'uint80': 
		case 'uint88': 
		case 'uint96': 
		case 'uint104': 
		case 'uint112': 
		case 'uint120': 
		case 'uint128': 
		case 'uint136': 
		case 'uint144': 
		case 'uint152': 
		case 'uint160': 
		case 'uint168': 
		case 'uint176': 
		case 'uint184': 
		case 'uint192': 
		case 'uint200': 
		case 'uint208': 
		case 'uint216': 
		case 'uint224': 
		case 'uint232': 
		case 'uint240': 
		case 'uint248': 
		case 'uint256': 
		case 'int8': 
		case 'int16': 
		case 'int24': 
		case 'int32': 
		case 'int40': 
		case 'int48': 
		case 'int56': 
		case 'int64': 
		case 'int72': 
		case 'int80': 
		case 'int88': 
		case 'int96': 
		case 'int104': 
		case 'int112': 
		case 'int120': 
		case 'int128': 
		case 'int136': 
		case 'int144': 
		case 'int152': 
		case 'int160': 
		case 'int168': 
		case 'int176': 
		case 'int184': 
		case 'int192': 
		case 'int200': 
		case 'int208': 
		case 'int216': 
		case 'int224': 
		case 'int232': 
		case 'int240': 
		case 'int248': 
		case 'int256': return 'integer'
		case 'bytes1': 
		case 'bytes2': 
		case 'bytes3': 
		case 'bytes4': 
		case 'bytes5': 
		case 'bytes6': 
		case 'bytes7': 
		case 'bytes8': 
		case 'bytes9': 
		case 'bytes10': 
		case 'bytes11': 
		case 'bytes12': 
		case 'bytes13': 
		case 'bytes14': 
		case 'bytes15': 
		case 'bytes16': 
		case 'bytes17': 
		case 'bytes18': 
		case 'bytes19': 
		case 'bytes20': 
		case 'bytes21': 
		case 'bytes22': 
		case 'bytes23': 
		case 'bytes24': 
		case 'bytes25': 
		case 'bytes26': 
		case 'bytes27': 
		case 'bytes28': 
		case 'bytes29': 
		case 'bytes30': 
		case 'bytes31': 
		case 'bytes32': return 'fixedBytes'
		case 'bool': return 'bool'
		case 'address': return 'address'
		case 'string': return 'string'
		case 'bytes': return 'bytes'
		default: assertNever(type)
	}
}

export async function parseSolidityValueByTypeEnriched(ethereumClientService: EthereumClientService, type: SolidityType, value: unknown, userAddressBook: UserAddressBook, isArray: boolean, useLocalStorage: boolean = true): Promise<EnrichedGroupedSolidityType> {	
	const categorized = getSolidityTypeCategory(type)
	if (categorized === 'address') {
		if (isArray) return { type: `address[]`, value: await Promise.all(funtypes.ReadonlyArray(EthereumAddress).parse(value).map((value) => identifyAddress(ethereumClientService, userAddressBook, value, useLocalStorage))) }
		return { type: 'address', value: await identifyAddress(ethereumClientService, userAddressBook, EthereumAddress.parse(value), useLocalStorage) }
	}
	const parsed = parseSolidityValueByTypePure(type, value, isArray)
	if (parsed.type === 'address' || parsed.type === 'address[]') throw new Error('parsed to address or address array')
	return parsed
}

export function parseSolidityValueByTypePure(type: SolidityType, value: unknown, isArray: boolean): PureGroupedSolidityType {	
	const categorized = getSolidityTypeCategory(type)
	if (isArray) {
		switch (categorized) {
			case 'address': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumAddress).parse(value) }
			case 'bool': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(funtypes.Union(NonHexBigInt, funtypes.Boolean)).parse(value).map((a) => a === 1n || a === true) }
			case 'bytes': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumData).parse(value) }
			case 'fixedBytes': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(EthereumData).parse(value) }
			case 'integer': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(funtypes.Union(NonHexBigInt, funtypes.Number, funtypes.BigInt)).parse(value).map((x) => BigInt(x)) }
			case 'string': return { type: `${ categorized }[]`, value: funtypes.ReadonlyArray(funtypes.String).parse(value) }
			default: assertNever(categorized)
		}
	}
	switch (categorized) {
		case 'address': return { type: categorized, value: EthereumAddress.parse(value) }
		case 'bool': {
			const parsed = funtypes.Union(NonHexBigInt, funtypes.Boolean).parse(value)
			return { type: categorized, value: parsed === 1n || parsed === true }
		}
		case 'bytes': return { type: categorized, value: EthereumData.parse(value) }
		case 'fixedBytes': return { type: categorized, value: EthereumData.parse(value) }
		case 'integer': return { type: categorized, value: BigInt(funtypes.Union(NonHexBigInt, funtypes.Number, funtypes.BigInt).parse(value)) }
		case 'string': return { type: categorized, value: funtypes.String.parse(value) }
		default: assertNever(categorized)
	}
}
