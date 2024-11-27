
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { MessageToPopup, ImportSettingsReply } from '../../types/interceptor-messages.js'
import { RpcEntries, RpcEntry } from '../../types/rpc.js'
import { useEffect, useState } from 'preact/hooks'
import { ErrorComponent } from '../subcomponents/Error.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { ConfigureRpcConnection } from '../subcomponents/ConfigureRpcConnection.js'
import { Collapsible } from '../subcomponents/Collapsible.js'
import { defaultRpcs } from '../../background/settings.js'
import { getChainName } from '../../utils/constants.js'
import { getRpcList } from '../../background/storageVariables.js'
import { useComputed, useSignal } from '@preact/signals'
import { serialize } from '../../types/wire-types.js'

type CheckBoxSettingParam = {
	text: string
	checked: boolean
	onInput: (checked: boolean) => void
}

function CheckBoxSetting(param: CheckBoxSettingParam) {
	return (
		<div class = 'container'>
			<label class = 'form-control' style = { 'color: var(--text-color); font-size: 1em;' }>
				<input type = 'checkbox'
					checked = { param.checked }
					onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { param.onInput(e.target.checked) } } }
				/>
				<p class = 'paragraph checkbox-text' style = { 'color: var(--text-color);' }> { param.text } </p>
			</label>
		</div>
	)
}

function ImportExport() {
	const [settingsReply, setSettingsReply] = useState<ImportSettingsReply | undefined>(undefined)
	const [dismissedNotification, setdDismissedNotification] = useState<boolean>(false)

	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_initiate_export_settings_reply') {
				setdDismissedNotification(false)
				return setSettingsReply(parsed)
			}
			if (parsed.method !== 'popup_initiate_export_settings') return
			downloadFile('interceptorSettingsAndAddressbook.json', parsed.data.fileContents)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	const downloadFile = (filename: string, fileContents: string) => {
		window.URL = window.webkitURL || window.URL
		const blobData = new Blob([fileContents], { type: 'text/json; charset = utf-8' })
		const a = document.createElement('a')
		a.href = window.URL.createObjectURL(blobData)
		a.download = filename
		a.style.display = 'none'
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
	}

	const importSettings = async (inputElement: { target: EventTarget | EventTarget & { files: FileList } | null }) => {
		if (inputElement.target === null) return
		if (!('files' in inputElement.target)) throw new Error('Did not select one file.')
		if (inputElement.target.files.length !== 1) throw new Error('Did not select one file.')
		const reader = new FileReader()
		const firstFile = inputElement.target.files[0]
		if (firstFile === undefined) throw new Error('File was undefined')
		reader.readAsText(firstFile)
		reader.onloadend = async () => {
			if (reader.result === null) throw new Error('failed to load file')
			await sendPopupMessageToBackgroundPage({ method: 'popup_import_settings', data: { fileContents: reader.result as string } })
		}
		reader.onerror = () => {
			console.error(reader.error)
			throw new Error('error on importing settings')
		}
	}
	const exportSettings = async () => await sendPopupMessageToBackgroundPage({ method: 'popup_get_export_settings' })

	return <>
		{ settingsReply !== undefined && settingsReply.data.success === false ?
			<ErrorComponent warning = { true } text = { settingsReply.data.errorMessage } />
			: <></> }
		{ settingsReply !== undefined && settingsReply.data.success === true && dismissedNotification === false ?
			<DinoSaysNotification
				text = { 'Settings and address book loaded!' }
				close = { () => setdDismissedNotification(true) }
			/>
			: <></> }
		<div class = 'popup-button-row'>
			<div style = 'display: flex; flex-direction: row;'>
				<label className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;'>
					Import settings
					<input type = 'file' accept = '.json' onInput = { importSettings } style = 'position: absolute; width: 100%; height: 100%; opacity: 0;' />
				</label>
				<button className = 'button is-primary' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { exportSettings }>
					Export settings
				</button>
			</div>
		</div>
	</>
}

export function SettingsView() {
	const [useTabsInsteadOfPopup, setUseTabsInsteadOfPopup] = useState<boolean>(false)
	const [metamaskCompatibilityMode, setMetamaskCompatibilityMode] = useState<boolean>(false)

	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_settingsUpdated') return sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
			if (parsed.method !== 'popup_requestSettingsReply') return
			setMetamaskCompatibilityMode(parsed.data.metamaskCompatibilityMode)
			setUseTabsInsteadOfPopup(parsed.data.useTabsInsteadOfPopup)
			return
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' }) }, [])

	async function requestToUseTabsInsteadOfPopup(checked: boolean) {
		await sendPopupMessageToBackgroundPage({
			method: 'popup_ChangeSettings',
			data: { useTabsInsteadOfPopup: checked }
		})
	}
	async function requestToMetamaskCompatibilityMode(checked: boolean) {
		await sendPopupMessageToBackgroundPage({
			method: 'popup_ChangeSettings',
			data: { metamaskCompatibilityMode: checked }
		})
	}

	return <main style = 'padding: 10px'>
		<div class = 'card' style = 'height: 100%;'>
			<header class = 'card-head card-header window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/settings.svg' />
					</span>
				</div>
				<div class = 'card-header-title'>
					<p className = 'paragraph'>
						Settings
					</p>
				</div>
			</header>
			<section class = 'card-body' style = 'padding-bottom: 10px'>
				<ul>
					<li>
						<p className = 'paragraph'>Misc</p>
						<CheckBoxSetting
							text = { 'Open popups as tabs (experimental)' }
							checked = { useTabsInsteadOfPopup }
							onInput = { requestToUseTabsInsteadOfPopup }
						/>
						<CheckBoxSetting
							text = { 'Metamask compatibility mode (mimics Metamask\'s behaviour on websites). After enabling or disabling this, please refresh the active tab to switch the behaviour on the site' }
							checked = { metamaskCompatibilityMode }
							onInput = { requestToMetamaskCompatibilityMode }
						/>
					</li>
					<li>
						<p className = 'paragraph'>Export & Import</p>
						<ImportExport/>
					</li>
					<li>
						<Collapsible summary = 'RPC Connections' defaultOpen = { true }>
							<div class = 'grid' style = '--gap-y: 0.5rem; padding: 0.5rem 0'>
								<RpcListings />
								<ConfigureRpcConnection />
							</div>
						</Collapsible>
					</li>
				</ul>
			</section>
		</div>
	</main>
}

const RpcListings = () => {
	const rpcEntries = useRpcConnectionsList()
	const latestEntry = useComputed(() => rpcEntries.value.at(0))

	const loadDefaultRpcs = () => sendPopupMessageToBackgroundPage({ method: 'popup_set_rpc_list', data: defaultRpcs })

	if (rpcEntries.value.length < 2 && latestEntry.value !== undefined) {
		return (
			<>
				<aside class = 'report' style = { { display: 'grid', height: '9rem', textAlign: 'center', rowGap: '0.5rem'} }>
					<p style = { { color: '#ffffff80' } }>Interceptor requires at least 1 active RPC connection to work, do you want to reset to the default list instead?</p>
					<button class = 'btn btn--outline' style = 'font-weight: 600' onClick = { loadDefaultRpcs }>Yes, load the default RPC list</button>
				</aside>
				<ul class = 'grid' style = '--gap-y: 0.5rem'>
					<RpcSummary info = { latestEntry.value } />
				</ul>
			</>
		)
	}

	return (
		<ul class = 'grid' style = '--gap-y: 0.5rem'>
			{ rpcEntries.value.map(entry => <RpcSummary info = { entry } />) }
		</ul>
	)
}

const RpcSummary = ({ info }: { info: RpcEntry }) => {
	const networkName = getChainName(info.chainId)

	// rerender form if entry is updated in the background by specifying a unique key
	const infoKey = JSON.stringify(serialize(RpcEntry, info))

	return (
		<li class = 'grid brief'>
			<div class = 'grid' style = '--grid-cols: 1fr max-content; --text-color: gray'>
				<div style = '--area: 1 / 1'><strong>{ info.name }</strong></div>
				<div style = '--area: span 2 / 2'>{ networkName }</div>
				<div>{ info.httpsRpc }</div>
			</div>
			<div class = 'actions'>
				<ConfigureRpcConnection key = { infoKey } rpcInfo = { info } />
			</div>
		</li>
	)
}

export function useRpcConnectionsList() {
	const entries = useSignal<RpcEntries>([])

	const trackRpcListChanges = (message: unknown) => {
		const parsedMessage = MessageToPopup.parse(message)
		if (parsedMessage.method === 'popup_update_rpc_list') { entries.value = parsedMessage.data }
	}

	const initiallyLoadEntriesFromStorage = async () => { entries.value = await getRpcList() }

	useEffect(() => {
		initiallyLoadEntriesFromStorage()
		browser.runtime.onMessage.addListener(trackRpcListChanges)
		return () => browser.runtime.onMessage.removeListener(trackRpcListChanges)
	}, [])

	return entries
}
