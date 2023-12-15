import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { WebsiteSocket } from '../../utils/requests.js'

type LinkParam = {
	websiteSocket: WebsiteSocket
	text: string
	url: string
}
export function Link({ url, text, websiteSocket }: LinkParam) {
	const click = async (event: Event) => {
		event.preventDefault()
		await sendPopupMessageToBackgroundPage({ method: 'popup_openWebPage', data: { url, websiteSocket } })
	}
	return <a onClick = { click } href = { url }> { text }</a>
}
