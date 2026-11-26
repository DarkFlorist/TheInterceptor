import * as assert from 'assert'
import { test } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const installer = new URL('../../scripts/install-chrome.sh', import.meta.url).pathname

for (const browser of ['CHROME_BIN', 'GOOGLE_CHROME_BIN', 'discovered', 'missing']) for (const displayInstalled of [false, true]) test(`Chrome installer provisions missing dependencies with ${ browser } and display helpers ${ displayInstalled }`, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'interceptor-install-chrome-'))
	try {
		const executable = async (name: string, body = 'exit 0') => {
			const file = join(directory, name)
			await Bun.write(file, `#!/bin/sh\n${ body }\n`)
			await chmod(file, 0o755)
			return file
		}
		const log = join(directory, 'packages.log')
		await executable('id', 'echo 0')
		await executable('apt-get', 'printf "%s\\n" "$*" >> "$INSTALL_CHROME_TEST_LOG"')
		const browserPath = browser === 'missing' ? '' : await executable(browser === 'discovered' ? 'chromium' : 'custom-chrome')
		if (displayInstalled) { await executable('xauth'); await executable('xvfb-run') }
		const child = Bun.spawn(['/bin/sh', installer], {
			env: { PATH: directory, CHROME_BIN: browser === 'CHROME_BIN' ? browserPath : '', GOOGLE_CHROME_BIN: browser === 'GOOGLE_CHROME_BIN' ? browserPath : '', INSTALL_CHROME_TEST_LOG: log },
			stdout: 'pipe', stderr: 'pipe',
		})
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
		assert.equal(exitCode, 0, `${ stdout }\n${ stderr }`)
		const expectedPackages = [...(browser === 'missing' ? ['chromium'] : []), ...(displayInstalled ? [] : ['xauth', 'xvfb'])]
		assert.equal(await Bun.file(log).exists(), expectedPackages.length > 0)
		if (expectedPackages.length > 0) assert.equal(await Bun.file(log).text(), `update\ninstall -y --no-install-recommends ${ expectedPackages.join(' ') }\n`)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
