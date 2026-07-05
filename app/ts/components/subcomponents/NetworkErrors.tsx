import type { Signal } from '@preact/signals'
import type { RpcConnectionStatus } from '../../types/user-interface-types.js'
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
