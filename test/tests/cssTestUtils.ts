export const interceptorAppStylesheetPaths = [
	'app/css/interceptor-theme.css',
	'app/css/interceptor-components.css',
	'app/css/interceptor-ui.css',
	'app/css/interceptor-pages.css',
] as const

export async function readInterceptorAppCss() {
	return (await Promise.all(interceptorAppStylesheetPaths.map(async (path) => await Bun.file(path).text()))).join('')
}
