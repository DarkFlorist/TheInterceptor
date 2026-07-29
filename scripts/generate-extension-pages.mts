import * as path from 'node:path'
import * as url from 'node:url'

type PolyfillPosition = 'before-root' | 'after-root'

export type PageDefinition = {
	name: string
	entryName?: string
	title: string
	htmlStyle: string
	bodyStyle?: string
	rootMarkup?: string
	includeBadgeStyles?: boolean
	includeDividerStyles?: boolean
	manifestV3HtmlStyle?: string
	manifestV3PolyfillPosition?: PolyfillPosition
}

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
export const pageDefinitions: readonly PageDefinition[] = [
	{
		name: 'addressBook',
		entryName: 'addressBookRender',
		title: 'Address Book - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-x: hidden; overflow-y: auto;',
	},
	{
		name: 'changeChain',
		title: 'Change Chain - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
	},
	{
		name: 'confirmTransaction',
		title: 'Confirm Transaction - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
		// Keep the MV3 polyfill before the root as a workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1803984.
		manifestV3PolyfillPosition: 'before-root',
	},
	{
		name: 'fetchSimulationStack',
		title: 'Simulation Stack Request - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
	},
	{
		name: 'interceptorAccess',
		title: 'Access Request - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
	},
	{
		name: 'popup',
		title: 'The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); width: 520px; height: 600px; min-width: 520px; overflow-y: inherit;',
		bodyStyle: 'width: 520px; height: 600px; background-color: var(--bg-color); min-width: 520px; margin: auto;',
		includeBadgeStyles: true,
	},
	{
		name: 'settingsView',
		title: 'Import settings - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
	},
	{
		name: 'simulationStack',
		title: 'Simulation Stack - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
		rootMarkup: `<div id = 'simulation-stack-root'>Loading...</div>`,
		includeBadgeStyles: true,
	},
	{
		name: 'websiteAccess',
		title: 'Website Access - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
		manifestV3HtmlStyle: 'background-color: var(--bg-color); overflow-y: scroll;',
	},
	{
		name: 'watchAsset',
		title: 'Watch Asset - The Interceptor',
		htmlStyle: 'background-color: var(--bg-color); overflow-y: inherit;',
		includeDividerStyles: false,
	},
]

const polyfillScript = `<script src = '../vendor/webextension-polyfill/dist/browser-polyfill.js'></script>`

export function renderExtensionPage(definition: PageDefinition, manifestVersion: 2 | 3) {
	const htmlStyle = manifestVersion === 3 ? definition.manifestV3HtmlStyle ?? definition.htmlStyle : definition.htmlStyle
	const bodyStyle = definition.bodyStyle ?? 'background-color: var(--bg-color); margin: auto;'
	const stylesheets = [
		`<link rel = 'stylesheet' type = 'text/css' href = '../css/bulma.css' />`,
		...(definition.includeDividerStyles === false ? [] : [`<link rel = 'stylesheet' type = 'text/css' href = '../css/bulma-divider.css' />`]),
		...(definition.includeBadgeStyles === true ? [`<link rel = 'stylesheet' type = 'text/css' href = '../css/bulma-badge.css' />`] : []),
		`<link rel = 'stylesheet' type = 'text/css' href = '../css/interceptor.css' />`,
	]
	const manifestV3PolyfillPosition = definition.manifestV3PolyfillPosition ?? 'after-root'
	const polyfillBeforeRoot = manifestVersion === 2 || manifestV3PolyfillPosition === 'before-root'
	const rootMarkup = definition.rootMarkup ?? '<main>Loading...</main>'
	const entryName = definition.entryName ?? definition.name
	return [
		'<!DOCTYPE html>',
		`<html style = '${ htmlStyle }'>`,
		'\t<head>',
		`\t\t<title>${ definition.title }</title>`,
		`\t\t<meta charset = 'utf-8'>`,
		`\t\t<link rel = 'icon' type = 'image/x-icon' href = 'favicon.ico'>`,
		'\t</head>',
		`\t<body style = '${ bodyStyle }'>`,
		`\t\t<meta name = 'viewport' content = 'width = device-width, initial-scale = 1' />`,
		...stylesheets.map((stylesheet) => `\t\t${ stylesheet }`),
		...(polyfillBeforeRoot ? [`\t\t${ polyfillScript }`] : []),
		`\t\t${ rootMarkup }`,
		'',
		...(!polyfillBeforeRoot ? [`\t\t${ polyfillScript }`] : []),
		`\t\t<script type = 'module' src = '../js/${ entryName }.js'></script>`,
		'\t</body>',
		'</html>',
		'',
	].join('\n')
}

export const generatedPages = pageDefinitions.flatMap((definition) => [
	{
		path: path.join(projectRoot, 'app', 'html', `${ definition.name }.html`),
		contents: renderExtensionPage(definition, 2),
	},
	{
		path: path.join(projectRoot, 'app', 'html3', `${ definition.name }V3.html`),
		contents: renderExtensionPage(definition, 3),
	},
])

export async function generateOrCheckExtensionPages(checkOnly: boolean) {
	if (!checkOnly) {
		await Promise.all(generatedPages.map(async (page) => await Bun.write(page.path, page.contents)))
		return
	}
	const stalePages: string[] = []
	for (const page of generatedPages) {
		const currentContents = await Bun.file(page.path).text()
		if (currentContents !== page.contents) stalePages.push(path.relative(projectRoot, page.path))
	}
	if (stalePages.length > 0) {
		throw new Error(`Generated extension pages are stale:\n${ stalePages.join('\n') }\nRun bun run generate-extension-pages.`)
	}
}

if (import.meta.main) {
	try {
		await generateOrCheckExtensionPages(process.argv.includes('--check'))
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	}
}
