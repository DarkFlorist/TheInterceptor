import type { Signal } from '@preact/signals'
import type { RpcNetwork } from '../../types/rpc.js'
import type { RpcConnectionStatus } from '../../types/user-interface-types.js'
import { getNetworkWithoutRpcWarning } from '../../utils/requestRouting.js'
import { getRpcWarningState, shouldShowRpcWarningCountdown } from '../../utils/rpcConnectionUi.js'
import { humanReadableDate } from '../ui-utils.js'
import { ErrorComponent } from './Error.js'
import { SomeTimeAgo } from './SomeTimeAgo.js'

type NetworkErrorParams = {
	rpcConnectionStatus: Signal<RpcConnectionStatus>
}

export function NetworkErrors({ rpcConnectionStatus } : NetworkErrorParams) {
	const status = rpcConnectionStatus.value
	if (status === undefined) return <></>
	const warningState = getRpcWarningState(status)
	if (warningState.kind === 'none') return <></>
	const showCountdown = shouldShowRpcWarningCountdown(warningState)

	if (warningState.kind === 'disconnected') {
		if (warningState.retryState === 'paused') {
			return <ErrorComponent warning = { true } text = { <>Unable to connect to { status.rpcNetwork.name }. Retrying resumes when the extension becomes active.</> }/>
		}
		if (showCountdown && warningState.nextRetryAt !== undefined) {
			return <ErrorComponent warning = { true } text = { <>Unable to connect to { status.rpcNetwork.name }. Retrying in <SomeTimeAgo priorTimestamp = { warningState.nextRetryAt } countBackwards = { true }/>.</> }/>
		}
		return <ErrorComponent warning = { true } text = { <>Unable to connect to { status.rpcNetwork.name }. Retrying now.</> }/>
	}

	if (warningState.kind === 'slowRequest') {
		return <ErrorComponent warning = { true } text = { <>The connected RPC ({ status.rpcNetwork.name }) is taking longer than expected to answer { warningState.slowRequest.method }. It has been waiting for <SomeTimeAgo priorTimestamp = { warningState.slowRequest.startedAt }/>.</> }/>
	}

	const latestBlock = status.latestBlock
	if (latestBlock === undefined || latestBlock === null) return <></>
	if (showCountdown && warningState.nextRetryAt !== undefined) {
		return <ErrorComponent warning = { true } text = {
			<>The connected RPC ({ status.rpcNetwork.name }) seems to be stuck at block { latestBlock.number } (occurred on: { humanReadableDate(latestBlock.timestamp) }). Retrying in <SomeTimeAgo priorTimestamp = { warningState.nextRetryAt } countBackwards = { true }/>.</>
		}/>
	}
	return <ErrorComponent warning = { true } text = {
		<>The connected RPC ({ status.rpcNetwork.name }) seems to be stuck at block { latestBlock.number } (occurred on: { humanReadableDate(latestBlock.timestamp) }). Retrying now.</>
	}/>
}

type NetworkWithoutRpcErrorParams = {
	rpcNetwork: RpcNetwork | undefined
	simulationMode: boolean
	// undefined when the page cannot tell whether the requesting website has a signer available
	signerAvailable: boolean | undefined
}

export function NetworkWithoutRpcError({ rpcNetwork, simulationMode, signerAvailable }: NetworkWithoutRpcErrorParams) {
	if (rpcNetwork === undefined) return <></>
	const warning = getNetworkWithoutRpcWarning(rpcNetwork, simulationMode, signerAvailable)
	if (warning === undefined) return <></>
	return <ErrorComponent text = { warning }/>
}
