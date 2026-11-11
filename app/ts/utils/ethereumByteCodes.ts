import { ecRecoverOverrideByteCode, getCodeByteCode as compiledGetCodeByteCode, gnosisSafeProxyProxyByteCode, governorProposalForwarderByteCode, storageReaderByteCode } from '../generated/ethereumByteCodes.js'
import { EthereumData } from '../types/wire-types.js'

export const getEcRecoverOverride = () => EthereumData.parse(ecRecoverOverrideByteCode)

export const getCodeByteCode = () => EthereumData.parse(compiledGetCodeByteCode)

export const getGnosisSafeProxyProxy = () => EthereumData.parse(gnosisSafeProxyProxyByteCode)

export const getStorageReaderByteCode = () => EthereumData.parse(storageReaderByteCode)

export const getGovernorProposalForwarder = () => EthereumData.parse(governorProposalForwarderByteCode)
