import * as path from 'node:path'
import * as url from 'node:url'

type PageDefinition = {
	name: string
	entryName?: string
	title: string
	htmlStyle: string
	bodyStyle?: string
	rootMarkup?: string
	includeBadgeStyles?: boolean
	manifestV3HtmlStyle?: string
	keepManifestV3PolyfillBeforeRoot?: boolean
}

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const pageDefinitions: readonly PageDefinition[] = [
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
		keepManifestV3PolyfillBeforeRoot: true,
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
]

const polyfillScript = `<script src = '../vendor/webextension-polyfill/dist/browser-polyfill.js'></script>`

function renderPage(definition: PageDefinition, manifestVersion: 2 | 3) {
	const htmlStyle = manifestVersion === 3 ? definition.manifestV3HtmlStyle ?? definition.htmlStyle : definition.htmlStyle
	const bodyStyle = definition.bodyStyle ?? 'background-color: var(--bg-color); margin: auto;'
	const stylesheets = [
		`<link rel = 'stylesheet' type = 'text/css' href = '../css/bulma.css' />`,
		`<link rel = 'stylesheet' type = 'text/css' href = '../css/bulma-divider.css' />`,
		...(definition.includeBadgeStyles === true ? [`<link rel = 'stylesheet' type = 'text/css' href = '../css/bulma-badge.css' />`] : []),
		`<link rel = 'stylesheet' type = 'text/css' href = '../css/interceptor.css' />`,
	]
	const polyfillBeforeRoot = manifestVersion === 2 || definition.keepManifestV3PolyfillBeforeRoot === true
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

const generatedPages = pageDefinitions.flatMap((definition) => [
	{
		path: path.join(projectRoot, 'app', 'html', `${ definition.name }.html`),
		contents: renderPage(definition, 2),
	},
	{
		path: path.join(projectRoot, 'app', 'html3', `${ definition.name }V3.html`),
		contents: renderPage(definition, 3),
	},
])

if (process.argv.includes('--check')) {
	const stalePages: string[] = []
	for (const page of generatedPages) {
		const currentContents = await Bun.file(page.path).text()
		if (currentContents !== page.contents) stalePages.push(path.relative(projectRoot, page.path))
	}
	if (stalePages.length > 0) {
		console.error(`Generated extension pages are stale:\n${ stalePages.join('\n') }\nRun bun run generate-extension-pages.`)
		process.exit(1)
	}
} else {
	await Promise.all(generatedPages.map(async (page) => await Bun.write(page.path, page.contents)))
}
