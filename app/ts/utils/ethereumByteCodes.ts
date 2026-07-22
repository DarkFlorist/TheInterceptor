import { compoundGovernanceTimeLockMulticallByteCode, ecRecoverOverrideByteCode, getCodeByteCode as compiledGetCodeByteCode, gnosisSafeProxyProxyByteCode } from '../generated/ethereumByteCodes.js'
import { EthereumData } from '../types/wire-types.js'

export const getEcRecoverOverride = () => EthereumData.parse(ecRecoverOverrideByteCode)

export const getCompoundGovernanceTimeLockMulticall = () => EthereumData.parse(compoundGovernanceTimeLockMulticallByteCode)

export const getCodeByteCode = () => EthereumData.parse(compiledGetCodeByteCode)

export const getGnosisSafeProxyProxy = () => EthereumData.parse(gnosisSafeProxyProxyByteCode)
