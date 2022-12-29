import { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'

type RenameAddressButtonParams = {
	children: ComponentChildren
	renameAddress: (() => void) | undefined
}
export default function RenameAddressButton(param: RenameAddressButtonParams) {
	const [display, setDisplay] = useState<boolean>(false)
	const showButton = (e: MouseEvent) => {
		e.preventDefault()
		setDisplay(true)
	}

	const hideButton = (e: MouseEvent) => {
		e.preventDefault()
		setDisplay(false)
	}
	if (param.renameAddress === undefined) return <> { param.children } </>
  	return (
      	<div onMouseEnter = { e => showButton(e) } onMouseLeave = { e => hideButton(e) } class = 'vertical-center' style = 'display: flex; position: relative; text-overflow: ellipsis; overflow: hidden;'>
			{ param.children }
			<button className = 'button is-primary is-small' onClick = { param.renameAddress } style = { `margin-left: 5px; height: 18px; ${ !display ? 'display: none;' : '' }` } >
				<span class = 'icon'>
					<img src = '../img/rename.svg'/>
				</span>
			</button>
		</div>
  	)
}
