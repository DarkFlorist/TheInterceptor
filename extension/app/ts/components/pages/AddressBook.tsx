import { useState, useEffect } from 'preact/hooks'
import { getChainName, isSupportedChain } from '../../utils/constants.js'
import { Error, ErrorCheckBox } from '../subcomponents/Error.js'

interface InterceptorChainChangeRequest {
	isInterceptorSupport: boolean,
	chainName: string,
	origin: string,
	icon: string | undefined,
	simulationMode: boolean,
}

export function AddressBook() {
	const [chainChangeData, setChainChangeData] = useState<InterceptorChainChangeRequest | undefined>(undefined)
	const [connectAnyway, setConnectAnyway] = useState<boolean>(false)

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			console.log('popup message')
			console.log(msg)
			fetch()
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		fetch()

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		};
	}, []);

	async function fetch() {
		const backgroundPage = await browser.runtime.getBackgroundPage()
		if( !('changeChainDialog' in backgroundPage.interceptor) || backgroundPage.interceptor.changeChainDialog === undefined) return window.close();
		const dialog = backgroundPage.interceptor.changeChainDialog
		setChainChangeData( {
			isInterceptorSupport : isSupportedChain(dialog.chainId),
			chainName : getChainName(BigInt(dialog.chainId)),
			origin: dialog.origin,
			icon: dialog.icon,
			simulationMode: dialog.simulationMode,
		} )
	}

	function approve() {
		browser.runtime.sendMessage( { method: 'popup_changeChainDialog', options: { accept: true } } )
	}

	function reject() {
		browser.runtime.sendMessage( { method: 'popup_changeChainDialog', options: { accept: false } } )
	}

	return (
		<main>
		{ chainChangeData === undefined ? <></> : <>
			<div className = 'block' style = 'margin-bottom: 0px; margin: 10px'>
				<header class = 'card-header window-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							<img src = '../img/access-key.svg'/>
						</span>
					</div>
					<p class = 'card-header-title'>
						<p className = 'paragraph'>
							Chain Change Request
						</p>
					</p>
				</header>
				<div class = 'card-content'>
					<article class = 'media'>
						{
							chainChangeData.icon === undefined ? <></> :
								<figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
									<p class = 'image is-64x64'>
										<img src = { chainChangeData.icon }/>
									</p>
								</figure>
						}
					</article>
					<div class = 'media-content' style = 'padding-bottom: 10px'>
						<div class = 'content'>
							<p className = 'title' style = 'white-space: normal; text-align: center;'>
								<p className = 'title' style = 'white-space: normal; text-align: center; font-weight: bold;'>
									{ chainChangeData.origin }
								</p>
								would like to switch to
								<p className = 'title' style = 'white-space: normal; text-align: center; font-weight: bold;'>
									{ chainChangeData.chainName }
								</p>
								{ !chainChangeData.isInterceptorSupport && chainChangeData.simulationMode ?
									<div style = 'font-size: 0.5em;'>
										<Error
											text = { 'This chain is not supported by The Interceptor. If you want to use this chain anyway. Select Signing mode instead of Simulation mode and attempt to change the chain again. You will then be able to disable The Interceptor and send transactions without protection of The Interceptor.' }
										/>
									</div>
								: <></> }
								{ !chainChangeData.isInterceptorSupport && !chainChangeData.simulationMode ?
									<div style = 'font-size: 1em;'>
										<ErrorCheckBox
											text = { 'This chain is not supported by The Interceptor. Would you like to disable The Interceptor and attempt to connect anyway?' }
											checked = { connectAnyway }
											onInput = { setConnectAnyway }
										/>
									</div>
								: <></> }
							</p>
						</div>
					</div>
					<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
						<button
							className = { `button is-primary ${ !chainChangeData.isInterceptorSupport ? 'is-danger' : '' }` }
							disabled = { !chainChangeData.isInterceptorSupport && ( (!connectAnyway && !chainChangeData.simulationMode ) || chainChangeData.simulationMode ) }
							style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;'
							onClick = { approve }>
							{ chainChangeData.isInterceptorSupport ? 'Change chain' : 'Disable The Interceptor and change' }
						</button>
						<button
							className = { `button is-primary ${ chainChangeData.isInterceptorSupport ? 'is-danger' : '' }` }
							style = { `flex-grow: 1; margin-left: 5px; margin-right: 5px;` }
							onClick = { reject } >
							Don't change
						</button>
					</div>
				</div>
			</div>

			<div class = 'content' style = 'height: 0.1px'/>
		</> }
		</main>
	)
}
