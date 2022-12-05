export function getEnv(name: string, defaultValue?: string) {
	const readValue = process.env[name]
	if (readValue !== undefined) return readValue
	if (defaultValue === undefined) throw new Error(`Required environment variable ${name} was not set.`)
	return defaultValue
}

export function getBoolEnv(name: string, defaultValue?: boolean) {
	const readValue = process.env[name]
	if (readValue === undefined && defaultValue !== undefined) return defaultValue
	if (readValue === undefined) throw new Error(`Required environment variable ${name} was not set.`)
	if (readValue.toLowerCase() === 'true') return true
	if (readValue.toLowerCase() === 'false') return false
	throw new Error(`Boolean environment variable ${name} was neither 'true' nor 'false'.`)
}

export function getIntegerEnv(name: string, defaultValue?: number) {
	const readValue = process.env[name]
	if (readValue === undefined && defaultValue !== undefined) return defaultValue
	if (readValue === undefined) throw new Error(`Required environment variable ${name} was not set.`)
	if (!/^[0-9]+?$/.test(readValue)) throw new Error(`Environment variable ${name} must be a base 10 integer number.`)
	if (readValue.length > 15) throw new Error(`Environment variable ${name} is too big (must be less than 2**53).`)
	return Number.parseInt(readValue)
}

export async function sleep(milliseconds: number) {
	return new Promise(resolve => setTimeout(resolve, milliseconds))
}
