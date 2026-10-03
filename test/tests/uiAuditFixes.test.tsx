import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { MultilineCard } from '../../app/ts/components/subcomponents/MultilineCard.js'
import { installDomMock } from './domMock.js'
import { interceptorAppStylesheetPaths, readInterceptorAppCss } from './cssTestUtils.js'

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

function stripCssComments(css: string) {
	return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

// Every CSS named colour keyword, so none can stand in for a theme token.
const namedColours = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ')
const literalColourPattern = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(|color\\(\\s*srgb|:.*\\b(${ namedColours.join('|') })\\b(?![-(])`)

const colourPaletteScopes = [':root', '.interceptor-mode-signing']

type CssLine = {
	text: string
	isSelectorLine: boolean
	enclosingSelector: string
}

// Trimmed stylesheet lines, each with the selector of the multi-line rule that most recently opened above it.
function getCssLines(css: string) {
	const texts = css.split('\n').map((line) => line.trim())
	// A comma-ended line belongs to a selector list only when the run of comma-ended lines leads to a line that opens a rule; otherwise it continues a multi-line value.
	const leadsToRuleOpening = (index: number): boolean => {
		const text = texts[index] ?? ''
		if (text.endsWith('{')) return true
		return text.endsWith(',') && leadsToRuleOpening(index + 1)
	}
	const lines: CssLine[] = []
	let enclosingSelector = ''
	for (const [index, text] of texts.entries()) {
		if (text.endsWith('{')) enclosingSelector = text.slice(0, -1).trim()
		lines.push({ text, isSelectorLine: leadsToRuleOpening(index), enclosingSelector })
	}
	return lines
}

// Properties that one multi-line rule declares more than once, where only the last declaration can apply. Font faces list fallback sources on purpose.
function getOverwrittenDeclarations(lines: readonly CssLine[]) {
	const overwritten: string[] = []
	let declaredProperties = new Set<string>()
	for (const line of lines) {
		if (line.text.endsWith('{') || line.text.startsWith('}')) declaredProperties = new Set<string>()
		const property = /^([a-z-]+):/.exec(line.text)?.[1]
		if (property === undefined || line.isSelectorLine || line.enclosingSelector === '@font-face') continue
		if (declaredProperties.has(property)) overwritten.push(`${ line.enclosingSelector } { ${ property } }`)
		declaredProperties.add(property)
	}
	return overwritten
}

// Selector lists of the rules outside any at-rule, with whitespace normalised.
function getTopLevelSelectors(css: string) {
	const selectors: string[] = []
	let depth = 0
	let pending = ''
	for (const character of css) {
		if (character === '{') {
			const selector = pending.trim().replace(/\s+/g, ' ')
			if (depth === 0 && !selector.startsWith('@')) selectors.push(selector)
			depth += 1
			pending = ''
		} else if (character === '}') {
			depth -= 1
			pending = ''
		} else if (character === ';') {
			pending = ''
		} else {
			pending += character
		}
	}
	return selectors
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
		// Text and outline colours are themed, so each one carries a light and a dark value.
		assert.match(css, /--accent-color:\s*light-dark\(#[0-9a-fA-F]{6}, #[0-9a-fA-F]{6}\)/)
		assert.match(css, /--danger-color:\s*light-dark\(#[0-9a-fA-F]{6}, #[0-9a-fA-F]{6}\)/)
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
		assert.match(frameworkCss, /\.button\.is-primary:active\s*\{[\s\S]*?background-color:\s*var\(--highlighted-primary-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-primary\[disabled\],[\s\S]*?background-color:\s*var\(--primary-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-danger:active\s*\{[\s\S]*?background-color:\s*var\(--highlighted-destructive-action-color\);/)
		assert.match(frameworkCss, /\.button\.is-danger\[disabled\],[\s\S]*?background-color:\s*var\(--destructive-action-color\);/)
		// Variants no page uses were removed from the framework styles; they must not come back unnoticed.
		assert.doesNotMatch(appCss, /\.is-outlined|\.is-link|\.is-light|\.is-success|\.breadcrumb/)
		const addAddressSource = await Bun.file('app/ts/components/pages/AddNewAddress.tsx').text()
		const accessListSource = await Bun.file('app/ts/components/pages/InterceptorAccessList.tsx').text()
		const configureRpcSource = await Bun.file('app/ts/components/subcomponents/ConfigureRpcConnection.tsx').text()
		assert.doesNotMatch(`${ addAddressSource }\n${ accessListSource }`, /background-color: var\(--danger-color\)/)
		assert.match(configureRpcSource, /Remove<\/span><\/button>|<Trash \/> Remove<\/span><\/button>/)
		assert.doesNotMatch(configureRpcSource, /--(?:btn-)?text-color: var\(--danger-color\)/)
		assert.match(configureRpcSource, /class = 'btn btn--ghost rpc-form-remove'[^\n]*<span class = 'grid rpc-form-remove-label'><Trash \/> Remove<\/span>/)
		assert.match(appCss, /\.rpc-form-remove\s*\{[^}]*--btn-text-color:\s*var\(--destructive-action-color\);/)
		assert.match(appCss, /\.rpc-form-remove-label\s*\{[^}]*--text-color:\s*var\(--destructive-action-color\);/)
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
		assert.match(css, /\.address-editor-setting--primary\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) max-content;[\s\S]*?min-width:\s*0;/)
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
			const spans = collectElements(dom.document.body, 'span')
			const actionOverlays = spans.filter((element) => element.getAttribute?.('class') === 'inline-card-actions')
			assert.equal(actionOverlays.length, 2)
			const actionGroups = spans.filter((element) => element.getAttribute?.('role') === 'group')
			assert.equal(actionGroups.length, 1)
			assert.equal(actionGroups[0]?.getAttribute?.('aria-label'), 'Spell-out actions')
			const staticOverlays = actionOverlays.filter((element) => element.getAttribute?.('role') === null)
			assert.equal(staticOverlays.length, 1)
			assert.equal(staticOverlays[0]?.getAttribute?.('aria-hidden'), true)
			const renderedText = dom.document.body.textContent
			assert.equal(renderedText.split('Static label').length - 1, 1)
			assert.equal(renderedText.split('Static note').length - 1, 1)
			const css = await readInterceptorAppCss()
			assert.match(css, /> \.inline-card-actions\s*\{[\s\S]*?display:\s*inline-grid;/)
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

	test('keeps secondary actions readable and visually lighter than the primary decisions', async () => {
		const confirmSource = await Bun.file('app/ts/components/pages/ConfirmTransaction.tsx').text()
		assert.match(confirmSource, /class = 'button button--secondary button-overflow dialog-action-button dialog-action-button--unsigned'[\s\S]*?text = 'Add unsigned'/)
		// Every approve/reject dialog uses the same hierarchy: a quiet reject and a single primary confirm.
		for (const dialogPath of ['app/ts/components/pages/ChangeChain.tsx', 'app/ts/components/pages/FetchSimulationStack.tsx']) {
			const dialogSource = await Bun.file(dialogPath).text()
			assert.match(dialogSource, /class = 'button button--secondary button-overflow dialog-action-button'/, dialogPath)
			assert.match(dialogSource, /class = 'button is-primary button-overflow dialog-action-button dialog-action-button--confirm'/, dialogPath)
		}
		for (const sourcePath of ['app/ts/components/pages/ChangeChain.tsx', 'app/ts/components/pages/FetchSimulationStack.tsx', 'app/ts/components/pages/WatchAsset.tsx', 'app/ts/components/pages/InterceptorAccessList.tsx', 'app/ts/AddressBook.tsx']) {
			const source = await Bun.file(sourcePath).text()
			assert.doesNotMatch(source, /'button is-danger|is-warning is-danger|'button is-link/, sourcePath)
			assert.doesNotMatch(source, /is-danger[^']*'[^>]*>Cancel</, sourcePath)
		}
		const homeSource = await Bun.file('app/ts/components/pages/Home.tsx').text()
		assert.match(homeSource, /class = \{ `button home-mode-button \$\{ param\.simulationMode\.value \? 'is-primary home-mode-button--active' : 'button--secondary' \}` \}/)
		assert.match(homeSource, /class = \{ `button home-mode-button \$\{ param\.simulationMode\.value \? 'button--secondary' : 'is-primary home-mode-button--active' \}` \}/)

		const css = await readInterceptorAppCss()
		// Secondary actions sit on a raised neutral surface with a hairline border, so only the primary decision carries the action colour.
		assert.match(css, /\.button\.button--secondary\s*\{[\s\S]*?background-color:\s*var\(--surface-raised-color\);[\s\S]*?border:\s*1px solid var\(--strong-hairline-color\);[\s\S]*?color:\s*var\(--text-color\);/)
		assert.match(css, /\.button\.button--secondary:hover, \.button\.button--secondary:focus, \.button\.button--secondary:active\s*\{[\s\S]*?background-color:\s*var\(--surface-highest-color\);[\s\S]*?color:\s*var\(--text-color\);/)
		assert.match(css, /\.button\.button--secondary\[disabled\]\s*\{[\s\S]*?border-color:\s*var\(--strong-hairline-color\);[\s\S]*?color:\s*var\(--text-color\);/)
		// The secondary Safe action wraps onto its own compact row below the two decisions in narrow popups.
		assert.match(css, /@container \(max-width: 42rem\)[\s\S]*?\.confirmation-action-buttons--safe > \.dialog-action-button--unsigned\s*\{[\s\S]*?flex:\s*1 1 100%;[\s\S]*?order:\s*1;/)
		assert.match(css, /@container \(max-width: 24rem\)[\s\S]*?\.confirmation-action-buttons--safe\s*\{[\s\S]*?flex-direction:\s*column;/)
	})

	test('keeps colours in theme tokens and leaves out styles browsers ignore', async () => {
		const stylesheets = await Promise.all(interceptorAppStylesheetPaths.map(async (stylesheetPath) => ({ stylesheetPath, css: stripCssComments(await Bun.file(stylesheetPath).text()) })))
		for (const { stylesheetPath, css } of stylesheets) {
			// A literal colour would not follow the light and dark themes, so colours live only in the token definitions of the theme's palette scopes.
			const isPaletteDefinition = (line: CssLine) => stylesheetPath === 'app/css/interceptor-theme.css' && line.text.startsWith('--') && colourPaletteScopes.includes(line.enclosingSelector)
			// Selector lines are skipped and the selector of a one-line rule is cut off, so an id selector can never be mistaken for a hex colour.
			const literalColours = getCssLines(css).filter((line) => !line.isSelectorLine && !isPaletteDefinition(line) && literalColourPattern.test(line.text.slice(line.text.indexOf('{') + 1))).map((line) => line.text)
			assert.deepEqual(literalColours, [], stylesheetPath)
			// Scrollbar pseudo-elements are ignored once `scrollbar-color` is set, and the supported browsers need none of these prefixes. Firefox-only `-moz-appearance: textfield` is deliberate and stays.
			const ignoredStyles = css.split('\n').map((line) => line.trim()).filter((line) => /::-webkit-scrollbar|(^|[\s{;])(-ms-|-moz-appearance:\s*none|-moz-user-select|-webkit-(appearance|user-select|box-align|align-items|animation|touch-callout|overflow-scrolling))|:-ms-input-placeholder|:-moz-placeholder|@-webkit-keyframes/.test(line))
			assert.deepEqual(ignoredStyles, [], stylesheetPath)
			// A prefixed property next to its standard form is redundant on the supported browsers.
			const cssLines = getCssLines(css)
			const standardDeclarations = new Set(cssLines.map((line) => `${ line.enclosingSelector }|${ /^([a-z-]+):/.exec(line.text)?.[1] ?? '' }`))
			const redundantPrefixes = cssLines.filter((line) => {
				const prefixedProperty = /^-(?:webkit|moz|ms)-([a-z-]+):/.exec(line.text)?.[1]
				return prefixedProperty !== undefined && standardDeclarations.has(`${ line.enclosingSelector }|${ prefixedProperty }`)
			}).map((line) => line.text)
			assert.deepEqual(redundantPrefixes, [], stylesheetPath)
			assert.deepEqual(getOverwrittenDeclarations(cssLines), [], stylesheetPath)
			assert.doesNotMatch(css, /\{\s*\}/, `${ stylesheetPath } has an empty rule set`)
			// Two top-level rules with the same selector list in one stylesheet hide which declaration wins; a shared group followed by a narrower rule is fine.
			const topLevelSelectors = getTopLevelSelectors(css)
			const repeatedSelectors = topLevelSelectors.filter((selector, index) => topLevelSelectors.indexOf(selector) !== index)
			assert.deepEqual(repeatedSelectors, [], stylesheetPath)
		}
		const appCss = await readInterceptorAppCss()
		// Every custom property that the theme defines, in any scope, must be read somewhere, or it is dead weight.
		const sources = [appCss]
		for await (const file of new Bun.Glob('app/ts/**/*.{ts,tsx}').scan('.')) sources.push(await Bun.file(file).text())
		const allSources = sources.join('\n')
		const themeCss = await Bun.file('app/css/interceptor-theme.css').text()
		const themeCustomProperties = [...themeCss.matchAll(/(?:^|[\s{;])(--[a-z0-9-]+):/gm)].map((match) => match[1] ?? '')
		const unusedTokens = themeCustomProperties.filter((token) => !allSources.includes(`var(${ token })`) && !allSources.includes(`var(${ token },`))
		assert.deepEqual([...new Set(unusedTokens)], [])
	})

	test('keeps static layout in stylesheets instead of inline style attributes', async () => {
		// A style attribute written as a plain string cannot depend on runtime values, so it belongs in a class. Strings that only place a component in its parent grid through custom properties are the exception.
		const staticInlineStyles: string[] = []
		for await (const file of new Bun.Glob('app/ts/**/*.tsx').scan('.')) {
			const source = await Bun.file(file).text()
			// Covers `style = '...'`, `style = { '...' }`, string fallbacks such as `style = { props.style ?? '...' }`, and backtick strings without interpolation.
			for (const match of source.matchAll(/style = (?:\{ (?:[\w.]+ \?\? )?)?['`]([^'`$]*)['`]/g)) {
				const declarations = (match[1] ?? '').split(';').map((declaration) => declaration.trim()).filter((declaration) => declaration !== '')
				if (declarations.length === 0 || declarations.some((declaration) => !declaration.startsWith('--'))) staticInlineStyles.push(`${ file }: ${ match[0] }`)
			}
		}
		assert.deepEqual(staticInlineStyles, [])
	})

	test('keeps the warning tag readable in both themes', async () => {
		const frameworkCss = await Bun.file('app/css/interceptor-framework.css').text()
		assert.match(frameworkCss, /\.tag:not\(body\)\.is-warning\s*\{\s*background-color:\s*var\(--warning-box-color\);\s*color:\s*var\(--warning-box-text\);/)
		const themeCss = await Bun.file('app/css/interceptor-theme.css').text()
		const readThemedPair = (token: string) => new RegExp(`--${ token }:\\s*light-dark\\((#[0-9a-fA-F]{6}),\\s*(#[0-9a-fA-F]{6})\\)`).exec(themeCss)
		const background = readThemedPair('warning-box-color')
		const text = readThemedPair('warning-box-text')
		for (const [themeName, themeIndex] of [['light', 1], ['dark', 2]] as const) {
			const backgroundColour = background?.[themeIndex]
			const textColour = text?.[themeIndex]
			if (backgroundColour === undefined || textColour === undefined) throw new Error(`warning tag colours are missing for the ${ themeName } theme`)
			assert.ok(contrastRatio(textColour, backgroundColour) >= 4.5, `warning tag needs at least 4.5:1 contrast in the ${ themeName } theme`)
		}
	})

	test('does not use the dim outlined primary button style anywhere in the extension UI', async () => {
		// `.button.is-primary.is-outlined` paints --primary-action-color text on dark surfaces at about 2:1 contrast; use button--secondary instead.
		for await (const file of new Bun.Glob('app/ts/**/*.{ts,tsx}').scan('.')) {
			assert.doesNotMatch(await Bun.file(file).text(), /is-outlined/, file)
		}
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
