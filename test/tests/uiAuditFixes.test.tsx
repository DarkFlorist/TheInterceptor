import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { MultilineCard } from '../../app/ts/components/subcomponents/MultilineCard.js'
import { installDomMock } from './domMock.js'
import { readInterceptorAppCss } from './cssTestUtils.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
}

function collectElements(node: TestNode | undefined, tagName: string, results: TestNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

function luminance(hex: string) {
	const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
		.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
	const [red = 0, green = 0, blue = 0] = channels
	return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(first: string, second: string) {
	const firstLuminance = luminance(first)
	const secondLuminance = luminance(second)
	return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05)
}

describe('UI audit fixes', () => {
	test('keeps action colors readable with white text in default and hover states', async () => {
		const css = await Bun.file('app/css/interceptor-theme.css').text()
		const actionColors = ['primary-action-color', 'highlighted-primary-action-color', 'destructive-action-color', 'highlighted-destructive-action-color']
		for (const variable of actionColors) {
			const color = new RegExp(`--${ variable }:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1]
			assert.notEqual(color, undefined)
			assert.ok(contrastRatio(color ?? '#ffffff', '#ffffff') >= 4.5, `${ variable } must have at least 4.5:1 contrast with white`)
		}
		const appCss = await readInterceptorAppCss()
		const frameworkCss = await Bun.file('app/css/interceptor-framework.css').text()
		const pageCss = await Bun.file('app/css/interceptor-pages.css').text()
		assert.match(css, /--accent-color:\s*#[0-9a-fA-F]{6}/)
		assert.match(css, /--danger-color:\s*#[0-9a-fA-F]{6}/)
		const deprecatedTokens = [
			'primary-color',
			'highlighted-primary-color',
			'disabled-primary-color',
			'negative-color',
			'highlighted-negative-color',
			'negative-dim-color',
			'button-color',
			'button-color-hilite',
			'negative-action-color',
			'highlighted-negative-action-color',
		]
		for (const deprecatedToken of deprecatedTokens) {
			const deprecatedTokenPattern = new RegExp(`--${ deprecatedToken }(?=\\s*[:),;])`)
			assert.doesNotMatch(appCss, deprecatedTokenPattern)
			assert.match(`color: var(--${ deprecatedToken }, var(--accent-color));`, deprecatedTokenPattern)
		}
		assert.match(appCss, /button:where\(:not\(\.btn\)\)\s*\{[\s\S]*?background-color:\s*var\(--primary-action-color\);/)
		assert.match(appCss, /button:not\(\.btn\):disabled, button:not\(\.btn\)\[disabled\]\s*\{[\s\S]*?background-color:\s*var\(--disabled-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-primary\s*\{[\s\S]*?background-color:\s*var\(--primary-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-danger\s*\{[\s\S]*?background-color:\s*var\(--destructive-action-color\);/)
		assert.doesNotMatch(pageCss, /(^|\n)\.button\.is-primary\s*\{/)
		assert.doesNotMatch(pageCss, /(^|\n)\.button\.is-danger\s*\{/)
		assert.match(appCss, /\.btn\.is-primary\s*\{[\s\S]*?background-color:\s*var\(--primary-action-color\);/)
		assert.match(appCss, /\.btn\.is-danger\s*\{[\s\S]*?background-color:\s*var\(--destructive-action-color\);/)
		assert.match(appCss, /\.button\.is-primary\.is-danger\s*\{[\s\S]*?background-color:\s*var\(--destructive-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-primary:active,[\s\S]*?background-color:\s*var\(--highlighted-primary-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-primary\[disabled\],[\s\S]*?background-color:\s*var\(--primary-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-primary\.is-outlined:hover,[\s\S]*?background-color:\s*var\(--primary-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-danger:active,[\s\S]*?background-color:\s*var\(--highlighted-destructive-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-danger\[disabled\],[\s\S]*?background-color:\s*var\(--destructive-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-danger\.is-outlined:hover,[\s\S]*?background-color:\s*var\(--destructive-action-color\);/)
		const addAddressSource = await Bun.file('app/ts/components/pages/AddNewAddress.tsx').text()
		const accessListSource = await Bun.file('app/ts/components/pages/InterceptorAccessList.tsx').text()
		assert.doesNotMatch(`${ addAddressSource }\n${ accessListSource }`, /background-color: var\(--danger-color\)/)
	})

	test('labels address editor text inputs and applies a single-column narrow layout', async () => {
		const source = await Bun.file('app/ts/components/pages/AddNewAddress.tsx').text()
		assert.match(source, /aria-label = 'Name'/)
		assert.match(source, /aria-label = \{ ariaLabel \}/)
		assert.match(source, /aria-label = 'ABI'/)
		assert.match(source, /class = 'safe-signer-owner-list' role = 'radiogroup' aria-label = 'Safe signer in simulation'/)

		const css = await readInterceptorAppCss()
		assert.match(css, /\.address-editor-identity-controls\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/)
		assert.match(css, /@container \(max-width: 280px\)[\s\S]*?\.address-editor-primary-identity\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/)
		assert.match(css, /@container \(max-width: 280px\)[\s\S]*?\.address-editor-address-icon\s*\{[\s\S]*?padding-top:\s*0;/)
		assert.match(css, /@container \(max-width: 280px\)[\s\S]*?\.address-editor-identity-controls\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/)
		assert.match(css, /@container \(max-width: 280px\)[\s\S]*?\.address-editor-address-field\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/)
		assert.match(css, /\.address-editor-modal\s*\{[\s\S]*?max-width:\s*min\(468px, calc\(100% - 32px\)\);/)
	})

	test('uses natural tab order and no fake buttons for inline and multiline card content', async () => {
		const dom = installDomMock()
		const Icon = () => <span>Icon</span>
		try {
			await act(() => render(<div>
				<InlineCard icon = { Icon } label = 'Copy me' />
				<InlineCard icon = { Icon } label = 'Static value' noCopy />
				<MultilineCard
					icon = { { icon: Icon, onClick: undefined } }
					label = { { displayText: 'Static label', onClick: undefined } }
					note = { { displayText: 'Static note', onClick: undefined } }
				/>
			</div>, dom.document.body))

			const buttons = collectElements(dom.document.body, 'button')
			assert.equal(buttons.length, 1)
			assert.equal(buttons[0]?.getAttribute?.('tabindex'), null)
			const actionGroups = collectElements(dom.document.body, 'span').filter((element) => element.getAttribute?.('role') === 'group')
			assert.equal(actionGroups.length, 2)
			const renderedText = dom.document.body.textContent
			assert.equal(renderedText.split('Static label').length - 1, 1)
			assert.equal(renderedText.split('Static note').length - 1, 1)
			const css = await readInterceptorAppCss()
			assert.match(css, /&:not\(:has\(\+ :is\(:disabled, \.multiline-card-static-action\)\)\)\s*\{/)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('humanizes failed simulation state and provides compact expandable Safe details', async () => {
		const confirmSource = await Bun.file('app/ts/components/pages/ConfirmTransaction.tsx').text()
		assert.match(confirmSource, /if \(status === 'FailedToSimulate'\) return 'Simulation failed'/)
		assert.match(confirmSource, /narrowSummary = \{ `Gnosis Safe transaction nonce/)

		const css = await readInterceptorAppCss()
		assert.match(css, /@media screen and \(max-width: 400px\)[\s\S]*?\.responsive-notification \.media\s*\{[\s\S]*?display:\s*none;/)
		assert.match(css, /\.responsive-notification-details\s*\{[\s\S]*?display:\s*block;/)
		assert.match(css, /\.responsive-notification-details summary\s*\{[\s\S]*?color:\s*var\(--text-color\);/)
	})

	test('stacks dense content before it overflows at narrow widths', async () => {
		const settingsSource = await Bun.file('app/ts/components/pages/SettingsView.tsx').text()
		const confirmSource = await Bun.file('app/ts/components/pages/ConfirmTransaction.tsx').text()
		const errorSource = await Bun.file('app/ts/components/subcomponents/Error.tsx').text()
		assert.match(settingsSource, /class = 'grid brief rpc-summary'/)
		assert.match(confirmSource, /class = 'card-header failed-transaction-header'/)
		assert.match(errorSource, /class = 'notification error-notification'/)

		const css = await readInterceptorAppCss()
		assert.match(css, /@media screen and \(max-width:\s*360px\)[\s\S]*?\.address-book-sidebar \.menu\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/)
		assert.match(css, /@media screen and \(max-width:\s*320px\)[\s\S]*?\.rpc-summary\s*\{[\s\S]*?--grid-cols:\s*minmax\(0, 1fr\);/)
		assert.match(css, /@media screen and \(max-width:\s*320px\)[\s\S]*?\.key-value-pair\s*\{[\s\S]*?--grid-cols:\s*minmax\(0, 1fr\);/)
		assert.match(css, /@media screen and \(max-width:\s*320px\)[\s\S]*?\.error-notification\s*\{[\s\S]*?flex-direction:\s*column;/)
		assert.match(css, /@media screen and \(max-width:\s*320px\)[\s\S]*?\.failed-transaction-header\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/)
		assert.match(css, /\.failed-transaction-header :is\(\.website-origin-text-origin, \.website-origin-text-title\)\s*\{[\s\S]*?white-space:\s*normal;/)
	})
})
