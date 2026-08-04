import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const GECKODRIVER_VERSION = '0.36.0'

async function runCommand(command: readonly string[], quiet = false) {
	const subprocess = Bun.spawn({
		cmd: command,
		stdin: 'inherit',
		stdout: quiet ? 'ignore' : 'inherit',
		stderr: quiet ? 'ignore' : 'inherit',
	})
	return await subprocess.exited
}

async function runRequiredCommand(command: readonly string[]) {
	const exitCode = await runCommand(command)
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${ exitCode }: ${ command.join(' ') }`)
}

async function runAsRoot(command: readonly string[]) {
	if (process.getuid?.() === 0) {
		await runRequiredCommand(command)
		return
	}
	if (Bun.which('sudo') === null) throw new Error(`Running ${ command[0] ?? 'this command' } requires root access, but sudo is not installed.`)
	await runRequiredCommand(['sudo', ...command])
}

async function installFirefox() {
	if (Bun.which('firefox') !== null) return
	if (Bun.which('apt-get') === null) {
		throw new Error('This helper only supports Debian/Ubuntu systems with apt-get. Install Firefox manually and set FIREFOX_BIN if it is outside the standard path.')
	}
	await runAsRoot(['apt-get', 'update'])
	const firefoxPackage = await runCommand(['apt-cache', 'show', 'firefox-esr'], true) === 0 ? 'firefox-esr' : 'firefox'
	await runAsRoot(['apt-get', 'install', '-y', '--no-install-recommends', firefoxPackage])
}

function geckodriverArchiveArchitecture() {
	if (process.arch === 'x64') return 'linux64'
	if (process.arch === 'arm64') return 'linux-aarch64'
	throw new Error(`Unsupported architecture for the geckodriver installer: ${ process.arch }`)
}

async function installGeckodriver() {
	if (Bun.which('geckodriver') !== null) return
	if (Bun.which('tar') === null) throw new Error('Install tar, then rerun this helper.')
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'interceptor-geckodriver-'))
	try {
		const archivePath = path.join(temporaryDirectory, 'geckodriver.tar.gz')
		const architecture = geckodriverArchiveArchitecture()
		const downloadUrl = `https://github.com/mozilla/geckodriver/releases/download/v${ GECKODRIVER_VERSION }/geckodriver-v${ GECKODRIVER_VERSION }-${ architecture }.tar.gz`
		const response = await fetch(downloadUrl)
		if (!response.ok) throw new Error(`Could not download geckodriver ${ GECKODRIVER_VERSION }: ${ response.status } ${ response.statusText }`)
		await Bun.write(archivePath, await response.arrayBuffer())
		await runRequiredCommand(['tar', '-xzf', archivePath, '-C', temporaryDirectory])
		await runAsRoot(['install', '-m', '0755', path.join(temporaryDirectory, 'geckodriver'), '/usr/local/bin/geckodriver'])
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true })
	}
}

async function main() {
	await installFirefox()
	await installGeckodriver()
	const firefoxPath = Bun.which('firefox')
	const geckodriverPath = Bun.which('geckodriver')
	if (firefoxPath === null || geckodriverPath === null) throw new Error('Firefox installation completed without exposing firefox and geckodriver on PATH.')
	console.log(`Firefox is installed at: ${ firefoxPath }`)
	console.log(`geckodriver is installed at: ${ geckodriverPath }`)
	console.log('Run the Firefox visual regression suite with:')
	console.log('  bun run screenshots:safe-ui:firefox')
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
