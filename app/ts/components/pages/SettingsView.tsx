
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { MessageToPopup, ImportSettingsReply } from '../../types/interceptor-messages.js'
import { RpcEntries } from '../../types/rpc.js'
import { useEffect, useState } from 'preact/hooks'
import { ErrorComponent } from '../subcomponents/Error.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { modifyObject } from '../../utils/typescript.js'
import { SetupNewRpc } from '../subcomponents/RpcConnectionSetup.js'

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
			<ErrorComponent warning = { true } text = { settingsReply.data.errorMessage }/>
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
					<input type = 'file' accept = '.json' onInput = { importSettings } style = 'position: absolute; width: 100%; height: 100%; opacity: 0;'/>
				</label>
				<button className = 'button is-primary' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { exportSettings }>
					Export settings
				</button>
			</div>
		</div>
	</>
}

type InputParams = {
	input: string
}
function TextField({ input }: InputParams) {
	return <input
		className = 'input title is-5 is-spaced'
		type = 'text'
		value = { input }
		maxLength = { 42 }
		disabled = { true }
	/>
}

function Rpcs({ rpcEntries }: { rpcEntries: RpcEntries }) {

	const expandMinimize = (rpcUrl: string, minimize: boolean) => {
		if (rpcEntries === undefined) return
		sendPopupMessageToBackgroundPage({
			method: 'popup_set_rpc_list',
			data: rpcEntries.map((rpc) => modifyObject(rpc, { minimized: rpcUrl === rpc.httpsRpc ? minimize : rpc.minimized, }))
		})
	}

	const setAsPrimary = (rpcUrl: string) => {
		if (rpcEntries === undefined) return
		const rpcInQuestion = rpcEntries.find((rpc) => rpcUrl === rpc.httpsRpc)
		if (rpcInQuestion === undefined) return
		if (rpcInQuestion.primary) return // already primary
		sendPopupMessageToBackgroundPage({
			method: 'popup_set_rpc_list',
			data: rpcEntries.map((rpc) => {
				if (rpcUrl === rpc.httpsRpc) return modifyObject(rpc, { primary: true })
				if (rpcInQuestion.chainId === rpc.chainId) return modifyObject(rpc, { primary: false })
				return rpc
			})
		})
	}

	return <>
		<ul> { rpcEntries.map((rpc) => <li>
			<div class = 'card'>
				<header class = 'card-header'>
					<div class = 'card-header-icon unset-cursor'>
						<input type = 'checkbox' checked = { rpc.primary } onInput = { () => { setAsPrimary(rpc.httpsRpc) } } />
					</div>
					<div class = 'card-header-title' style = 'white-space: nowrap; overflow: hidden;'>
						<p className = 'paragraph' style = 'text-overflow: ellipsis; overflow: hidden; overflow: hidden;'> { rpc.name } </p>
					</div>
					<button class = 'card-header-icon' aria-label = 'remove' onClick = { () => expandMinimize(rpc.httpsRpc, !rpc.minimized) }>
						<span class = 'icon' style = 'color: var(--text-color);'> V </span>
					</button>
				</header>
				{ rpc.minimized ? <></> :
					<div class = 'card-content'>
					<div class = 'paragraph'>Network</div>
					<TextField input = { rpc.name }/>
					<div class = 'paragraph'>RPC URL</div>
					<TextField input = { rpc.httpsRpc }/>
					<div class = 'paragraph'>Chain ID</div>
					<TextField input = { String(rpc.chainId) }/>
					<div class = 'paragraph'>Currency Name</div>
					<TextField input = { rpc.currencyName }/>
					<div class = 'paragraph'>Currency Ticker</div>
					<TextField input = { rpc.currencyTicker }/>
					<div class = 'paragraph'>{ `Primary RPC for Chain ID ${ String(rpc.chainId) }` }</div>
					<CheckBoxSetting
							text = ''
							checked = { rpc.primary }
							onInput = { () => { setAsPrimary(rpc.httpsRpc) } }
						/>
				</div>
				}
			</div>
		</li>)
		} </ul>
	</>
}

export function SettingsView() {
	const [useTabsInsteadOfPopup, setUseTabsInsteadOfPopup] = useState<boolean>(false)
	const [metamaskCompatibilityMode, setMetamaskCompatibilityMode] = useState<boolean>(false)
	const [rpcEntries, setRpcEntries] = useState<RpcEntries>([])

	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_settingsUpdated') return sendPopupMessageToBackgroundPage({ method: 'popup_settingsOpened' })
			if (parsed.method === 'popup_update_rpc_list') return setRpcEntries(parsed.data)
			if (parsed.method !== 'popup_settingsOpenedReply') return
			setMetamaskCompatibilityMode(parsed.data.metamaskCompatibilityMode)
			setUseTabsInsteadOfPopup(parsed.data.useTabsInsteadOfPopup)
			setRpcEntries(parsed.data.rpcEntries)
			return
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_settingsOpened' }) }, [])

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
						<img src = '../img/settings.svg'/>
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
							<p className = 'paragraph'>RPC Connections</p>
						<Rpcs rpcEntries = { rpcEntries } />
						<SetupNewRpc />
					</li>
				</ul>
			</section>
		</div>
	</main>
}

