export const RED = '\x1b[31m'
export const GREEN = '\x1b[32m'
export const RESET = '\x1b[0m'
import * as url from 'url'
import * as process from 'process'

const red = '\x1b[31m'
const green = '\x1b[32m'
const reset = '\x1b[0m'

type TestFunction = () => void

type TestCase = {
	message: string
	test: TestFunction
	skip?: boolean
}

type ShouldParams = {
	message: string
	test: TestFunction
}

async function runOne({ message, test, skip }: TestCase) {
	console.log()
	let output = `should ${ message.replace(/^should\s+/, '') }`
	console.log(`- ${ output }:`)
	if (skip) {
		console.log(`(skip) ${ output }`)
		return true
	}
	try {
		test()
		console.log(`${ green }√ ${ output }${ reset }`)
		return true
	} catch (error) {
		console.error(`${ red }x ${ output }${ reset }`)
		throw error
	}
}

class MicroShould {
	private prefix = ''
	private queue: TestCase[] = []
	private onlyQueue: TestCase | undefined = undefined

	private addPrefix = (message: string) => [this.prefix, message].filter((a) => a).join(' ')
	private enqueue = (param: TestCase ) => this.queue.push({ message: this.addPrefix(param.message), test: param.test, skip: param.skip })

	public should = ( message: string, test: TestFunction) => { this.enqueue({ message, test }) }
	public only = ( { message, test }: ShouldParams) => { this.onlyQueue = { message, test } }
	public skip = ( { message, test }: ShouldParams) => { this.enqueue({ message, test, skip: true }) }

	public run = async () => {
		const items = this.onlyQueue ? [this.onlyQueue] : this.queue
		this.queue = []
		this.onlyQueue = undefined
		for (const test of items) {
			await runOne(test)
		}
	}

	public describe = (prefix: string, nextLevelFunction: () => void) => {
		const old = this.prefix
		this.prefix = [old, prefix].filter((a) => a).join(' ')
		nextLevelFunction()
		this.prefix = old
	}
}

export async function runIfRoot(func: () => Promise<void>, importMeta: any) {
	if (process.argv[1] !== url.fileURLToPath(importMeta.url)) return
	try {
		await func()
		process.exit(0)
	} catch (error: unknown) {
		console.dir(error, { colors: true, depth: null })
		process.exit(1)
	}
}

const microShould = new MicroShould()

export const only = microShould.only
export const skip = microShould.skip
export const should = microShould.should
export const describe = microShould.describe
export const run = microShould.run
