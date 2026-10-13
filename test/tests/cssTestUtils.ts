import * as assert from 'node:assert'

const interceptorAppStylesheetPaths = [
	'app/css/interceptor-framework.css',
	'app/css/interceptor-controls.css',
	'app/css/interceptor-theme.css',
	'app/css/interceptor-components.css',
	'app/css/interceptor-ui.css',
	'app/css/interceptor-pages.css',
] as const

export async function readInterceptorAppCss() {
	return (await Promise.all(interceptorAppStylesheetPaths.map(async (path) => await Bun.file(path).text()))).join('')
}

// Returns the first capture group of pattern in css (usually a rule body), failing the test when the pattern does not match.
export function matchCssBlock(css: string, pattern: RegExp) {
	const capturedCss = css.match(pattern)?.[1]
	assert.ok(capturedCss !== undefined, `Expected the stylesheet to match ${ pattern }`)
	return capturedCss
}
