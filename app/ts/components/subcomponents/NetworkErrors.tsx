import type { Signal } from '@preact/signals'
import type { RpcNetwork } from '../../types/rpc.js'
import type { RpcConnectionStatus } from '../../types/user-interface-types.js'
import { isBypassingInterceptorOnNetworkWithoutRpc } from '../../utils/requestRouting.js'
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
	if (rpcNetwork === undefined || rpcNetwork.httpsRpc !== undefined) return <></>
	// Mirror the background routing so the page only claims the Interceptor is disabled when requests really bypass it.
	const mayBypassInterceptor = isBypassingInterceptorOnNetworkWithoutRpc(rpcNetwork, { simulationMode, signerAvailable: signerAvailable ?? true })
	if (!mayBypassInterceptor) return <ErrorComponent text = { `${ rpcNetwork.name } has no configured RPC. Select or configure an RPC for ${ rpcNetwork.name }.` }/>
	if (signerAvailable === undefined) return <ErrorComponent text = { `${ rpcNetwork.name } has no configured RPC. Until one is configured, the Interceptor cannot simulate requests on ${ rpcNetwork.name }; in signing mode with a connected wallet they go to the wallet directly.` }/>
	return <ErrorComponent text = { `${ rpcNetwork.name } is not a supported network. The Interceptor is disabled while you are using ${ rpcNetwork.name }.` }/>
}
