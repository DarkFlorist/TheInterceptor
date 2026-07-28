import { type Signal, type ReadonlySignal, useSignal } from '@preact/signals'
import type { JSX } from 'preact'
import { useEffect } from 'preact/hooks'
import type { EditEnsNamedHashWindowState, ModifyAddressWindowState } from '../types/visualizer-types.js'
import type { AddAddressParam, ChangeActiveAddressParam, InterceptorAccessListParams } from '../types/user-interface-types.js'
import type { SignerName } from '../types/signerTypes.js'
import { ErrorBoundary } from './subcomponents/Error.js'
import { CenterToPageTextSpinner } from './subcomponents/Spinner.js'

export type PopupPage = { page: 'Home' | 'ChangeActiveAddress' | 'AccessList' | 'Settings' | 'Unknown' }
	| { page: 'EditEnsNamedHash', state: EditEnsNamedHashWindowState }
	| { page: 'ModifyAddress' | 'AddNewAddress', state: Signal<ModifyAddressWindowState> }
	| { page: 'ImportSimulation', state: Signal<string> }

type LazyPageComponent<T extends object> = ((props: T) => JSX.Element) | undefined
type LazyPageModule<T extends object, ExportName extends string> = Record<ExportName, (props: T) => JSX.Element>

function useLazyPage<T extends object, ExportName extends string>(loader: () => Promise<LazyPageModule<T, ExportName>>, exportName: ExportName) {
	const component = useSignal<LazyPageComponent<T>>(undefined)
	useEffect(() => {
		let cancelled = false
		void loader().then((module) => {
			if (cancelled) return
			component.value = module[exportName]
		})
		return () => {
			cancelled = true
		}
	}, [])
	return component
}

function createLazyPage<T extends object, ExportName extends string>(loader: () => Promise<LazyPageModule<T, ExportName>>, exportName: ExportName) {
	return function LazyPage(props: T) {
		const component = useLazyPage(loader, exportName)
		if (component.value === undefined) return <CenterToPageTextSpinner />
		const Component = component.value
		return <Component { ...props } />
	}
}

const LazyChangeActiveAddress = createLazyPage<ChangeActiveAddressParam, 'ChangeActiveAddress'>(
	() => import('./pages/ChangeActiveAddress.js'),
	'ChangeActiveAddress',
)

const LazyAddNewAddress = createLazyPage<AddAddressParam, 'AddNewAddress'>(
	() => import('./pages/AddNewAddress.js'),
	'AddNewAddress',
)

const LazyInterceptorAccessList = createLazyPage<InterceptorAccessListParams, 'InterceptorAccessList'>(
	() => import('./pages/InterceptorAccessList.js'),
	'InterceptorAccessList',
)

const LazyEditEnsLabelHash = createLazyPage<{ close: () => void, editEnsNamedHashWindowState: EditEnsNamedHashWindowState }, 'EditEnsLabelHash'>(
	() => import('./pages/EditEnsLabelHash.js'),
	'EditEnsLabelHash',
)

const LazyImportSimulationStack = createLazyPage<{ close: () => void, simulationInput: Signal<string> }, 'ImportSimulationStack'>(
	() => import('./pages/ImportSimulationStack.js'),
	'ImportSimulationStack',
)

type PopupModalProps = {
	page: ReadonlySignal<PopupPage>
	boundaryResetKey: ReadonlySignal<number>
	onRenderError: (error: Error) => void
	goHome: () => void
	websiteAccess: InterceptorAccessListParams['websiteAccess']
	websiteAccessAddressMetadata: InterceptorAccessListParams['websiteAccessAddressMetadata']
	renameAddressCallBack: InterceptorAccessListParams['renameAddressCallBack']
	setActiveAddressAndInformAboutIt: NonNullable<AddAddressParam['setActiveAddressAndInformAboutIt']>
	signerAccounts: ChangeActiveAddressParam['signerAccounts']
	activeAddresses: ChangeActiveAddressParam['activeAddresses']
	signerName: SignerName
	addNewAddress: ChangeActiveAddressParam['addNewAddress']
	activeAddress: bigint | undefined
	rpcEntries: AddAddressParam['rpcEntries']
}

export function PopupModal(props: PopupModalProps) {
	const page = props.page.value
	return <div class = { `modal ${ page.page !== 'Home' && page.page !== 'Unknown' ? 'is-active' : ''}` }>
		{ page.page === 'EditEnsNamedHash' ?
			<ErrorBoundary key = { props.boundaryResetKey.value } onError = { props.onRenderError }><LazyEditEnsLabelHash
				close = { props.goHome }
				editEnsNamedHashWindowState = { page.state }
			/></ErrorBoundary>
		: <></> }
		{ page.page === 'AccessList' ?
			<ErrorBoundary key = { props.boundaryResetKey.value } onError = { props.onRenderError }><LazyInterceptorAccessList
				goHome = { props.goHome }
				websiteAccess = { props.websiteAccess }
				websiteAccessAddressMetadata = { props.websiteAccessAddressMetadata }
				renameAddressCallBack = { props.renameAddressCallBack }
			/></ErrorBoundary>
		: <></> }
		{ page.page === 'ChangeActiveAddress' ?
			<ErrorBoundary key = { props.boundaryResetKey.value } onError = { props.onRenderError }><LazyChangeActiveAddress
				setActiveAddressAndInformAboutIt = { props.setActiveAddressAndInformAboutIt }
				signerAccounts = { props.signerAccounts }
				close = { props.goHome }
				activeAddresses = { props.activeAddresses }
				signerName = { props.signerName }
				renameAddressCallBack = { props.renameAddressCallBack }
				addNewAddress = { props.addNewAddress }
			/></ErrorBoundary>
		: <></> }
		{ page.page === 'AddNewAddress' || page.page === 'ModifyAddress' ?
			<ErrorBoundary key = { props.boundaryResetKey.value } onError = { props.onRenderError }><LazyAddNewAddress
				setActiveAddressAndInformAboutIt = { props.setActiveAddressAndInformAboutIt }
				modifyAddressWindowState = { page.state }
				close = { props.goHome }
				activeAddress = { props.activeAddress }
				rpcEntries = { props.rpcEntries }
			/></ErrorBoundary>
		: <></> }
		{ page.page === 'ImportSimulation' ?
			<ErrorBoundary key = { props.boundaryResetKey.value } onError = { props.onRenderError }><LazyImportSimulationStack
				close = { props.goHome }
				simulationInput = { page.state }
			/></ErrorBoundary>
		: <></> }
	</div>
}
