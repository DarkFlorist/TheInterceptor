
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { SettingsParam } from '../../utils/user-interface-types.js'

type CheckBoxSettingParam = {
	text: string
	checked: boolean
	onInput: (checked: boolean) => void
}

function CheckBoxSetting(param: CheckBoxSettingParam) {
	return (
		<div class = 'container'>
			<label class = 'form-control' style = { `color: var(--text-color); font-size: 1em;` }>
				<input type = 'checkbox'
					checked = { param.checked }
					onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { param.onInput(e.target.checked) } } }
				/>
				<p class = 'paragraph checkbox-text' style = { `color: var(--text-color);` }> { param.text } </p>
			</label>
		</div>
	)
}

export function SettingsView(param: SettingsParam) {
	function goHome() {
		param.setAndSaveAppPage('Home')
	}

	async function setUseTabsInsteadOfPopups(checked: boolean) {
		await sendPopupMessageToBackgroundPage({
			method: 'popup_ChangeSettings',
			data: {
				useTabsInsteadOfPopup: checked
			}
		})
	}

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card' style = 'height: 100%;'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/settings.svg'/>
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
					Settings
					</p>
				</p>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { goHome }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body'>
				<ul>
					<li>
						<CheckBoxSetting
							text = { 'Open popups as tabs (experimetal)' }
							checked = { param.useTabsInsteadOfPopup === true }
							onInput = { setUseTabsInsteadOfPopups }
						/>
					</li>
				</ul>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-primary is-success' onClick = { goHome }> Close </button>
			</footer>
		</div>
	</> )
}
