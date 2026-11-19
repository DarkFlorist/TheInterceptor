import { stylesheetFilenames } from '../../scripts/generate-extension-pages.mts'

// The stylesheets in the order every page loads them, taken from the page generator so the tests can never read them in a different order.
export const interceptorAppStylesheetPaths = stylesheetFilenames.map((filename) => `app/css/${ filename }`)

export async function readInterceptorAppCss() {
	return (await Promise.all(interceptorAppStylesheetPaths.map(async (path) => await Bun.file(path).text()))).join('')
}
