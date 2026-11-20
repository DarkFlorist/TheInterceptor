import * as funtypes from 'funtypes'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

// A governance fixture keeps, for each request a preview sent, the request's method, the SHA-256 digest of its wire form and the node's result. A replay needs only the digest to find the result, and the tests inspect the requests the replayed preview sends, not the recorded ones.
export type RecordedExchange = funtypes.Static<typeof RecordedExchange>
const RecordedExchange = funtypes.ReadonlyObject({ method: funtypes.String, requestDigest: funtypes.String, result: funtypes.Unknown })

// safeExecutionExecutor is the executor account prepareSafeExecutionSimulationInput used when the fixture was recorded. It is random for each session, so a replay maps the session's executor to it.
export type GovernanceFixture = funtypes.Static<typeof GovernanceFixture>
const GovernanceFixture = funtypes.ReadonlyObject({
	description: funtypes.String,
	governor: funtypes.String,
	proposalId: funtypes.String,
	exchanges: funtypes.ReadonlyArray(RecordedExchange),
}).And(funtypes.ReadonlyPartial({ stack: funtypes.String, safeExecutionExecutor: funtypes.String }))

const SharedValues = funtypes.ReadonlyRecord(funtypes.String, funtypes.Unknown)

const FIXTURE_DIRECTORY = new URL('./fixtures/governance/', import.meta.url)
// Kept outside FIXTURE_DIRECTORY, so every file in that directory is a fixture.
const SHARED_VALUES_FILE = new URL('./fixtures/governance-shared-values.json', import.meta.url)
// A recorded value whose JSON is at least this long and that occurs in more than one place, such as a contract's code or a simulated block an earlier request returned too, is stored once in SHARED_VALUES_FILE.
const SHARED_VALUE_MINIMUM_LENGTH = 100

export const sha256Digest = (text: string) => createHash('sha256').update(text).digest('hex')

// A shared value is referred to as { sharedValue: <SHA-256 digest of its JSON> }. Node results never have that shape, and shareRepeatedValues refuses to record one that does.
type SharedValueReference = { readonly sharedValue: string }
const isSharedValueReference = (value: unknown): value is SharedValueReference => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && 'sharedValue' in value && typeof value.sharedValue === 'string'

const childValues = (value: unknown): readonly unknown[] => {
	if (Array.isArray(value)) return value
	if (typeof value === 'object' && value !== null) return Object.values(value)
	return []
}

const mapChildValues = (value: unknown, mapChild: (child: unknown) => unknown): unknown => {
	if (Array.isArray(value)) return value.map(mapChild)
	if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapChild(child)]))
	return value
}

// Replaces every shared value reference with the value, and fails when the value is missing or is not the value its digest names.
const expandSharedValues = (value: unknown, sharedValues: ReadonlyMap<string, unknown>, expanded: Map<string, unknown>): unknown => {
	if (!isSharedValueReference(value)) return mapChildValues(value, (child) => expandSharedValues(child, sharedValues, expanded))
	const digest = value.sharedValue
	const known = expanded.get(digest)
	if (known !== undefined) return known
	if (!sharedValues.has(digest)) throw new Error(`${ SHARED_VALUES_FILE.pathname } has no shared value ${ digest }`)
	const sharedValue = expandSharedValues(sharedValues.get(digest), sharedValues, expanded)
	if (sha256Digest(JSON.stringify(sharedValue)) !== digest) throw new Error(`The shared value ${ digest } in ${ SHARED_VALUES_FILE.pathname } does not match its digest`)
	expanded.set(digest, sharedValue)
	return sharedValue
}

const readJson = async (file: URL) => JSON.parse(await fs.readFile(file, 'utf8'))

const loadSharedValues = async () => new Map(Object.entries(SharedValues.parse(await readJson(SHARED_VALUES_FILE))))

const expandFixture = (fixture: GovernanceFixture, sharedValues: ReadonlyMap<string, unknown>, expanded: Map<string, unknown>): GovernanceFixture => ({
	...fixture,
	exchanges: fixture.exchanges.map((exchange) => ({ ...exchange, result: expandSharedValues(exchange.result, sharedValues, expanded) })),
})

// Each fixture is the RPC conversation of one preview, recorded from a real node by scripts/record-governance-fixtures.mts; its description names the chain state it was recorded on.
export const loadGovernanceFixture = async (name: string) => expandFixture(GovernanceFixture.parse(await readJson(new URL(`${ name }.json`, FIXTURE_DIRECTORY))), await loadSharedValues(), new Map())

export const loadGovernanceFixtures = async () => {
	const sharedValues = await loadSharedValues()
	const expanded = new Map<string, unknown>()
	const fileNames = (await fs.readdir(FIXTURE_DIRECTORY)).filter((fileName) => fileName.endsWith('.json')).sort()
	const fixtures = new Map<string, GovernanceFixture>()
	for (const fileName of fileNames) fixtures.set(fileName.slice(0, -'.json'.length), expandFixture(GovernanceFixture.parse(await readJson(new URL(fileName, FIXTURE_DIRECTORY))), sharedValues, expanded))
	return fixtures
}

// Counts each value of at least SHARED_VALUE_MINIMUM_LENGTH once per place it occurs, without counting again the values inside a value already counted, as those are stored inside its single shared copy.
const countRepeatedValues = (value: unknown, counts: Map<string, number>) => {
	const json = JSON.stringify(value)
	if (json.length >= SHARED_VALUE_MINIMUM_LENGTH) {
		const count = counts.get(json)
		counts.set(json, (count ?? 0) + 1)
		if (count !== undefined) return
	}
	for (const child of childValues(value)) countRepeatedValues(child, counts)
}

const shareValue = (value: unknown, counts: ReadonlyMap<string, number>, sharedValues: Map<string, unknown>): unknown => {
	if (isSharedValueReference(value)) throw new Error(`A recorded value has the shape of a shared value reference: ${ JSON.stringify(value) }`)
	const json = JSON.stringify(value)
	const sharedChildren = () => mapChildValues(value, (child) => shareValue(child, counts, sharedValues))
	if (json.length < SHARED_VALUE_MINIMUM_LENGTH || (counts.get(json) ?? 0) < 2) return sharedChildren()
	const digest = sha256Digest(json)
	if (!sharedValues.has(digest)) sharedValues.set(digest, sharedChildren())
	return { sharedValue: digest }
}

// Moves every repeated value of the recorded results into one shared table. It depends only on the fixtures, so writing the same fixtures again gives the same files.
const shareRepeatedValues = (fixtures: ReadonlyMap<string, GovernanceFixture>) => {
	const counts = new Map<string, number>()
	for (const fixture of fixtures.values()) for (const exchange of fixture.exchanges) countRepeatedValues(exchange.result, counts)
	const sharedValues = new Map<string, unknown>()
	const sharedFixtures = new Map(Array.from(fixtures, ([name, fixture]) => [name, { ...fixture, exchanges: fixture.exchanges.map((exchange) => ({ ...exchange, result: shareValue(exchange.result, counts, sharedValues) })) }]))
	return { sharedFixtures, sharedValues }
}

// One exchange or shared value per line, so a re-recording changes only the lines of what changed.
const formatFixture = ({ exchanges, ...header }: GovernanceFixture) => `${ JSON.stringify(header).slice(0, -1) },"exchanges":[\n${ exchanges.map((exchange) => JSON.stringify(exchange)).join(',\n') }\n]}\n`
const formatSharedValues = (sharedValues: ReadonlyMap<string, unknown>) => `{\n${ Array.from(sharedValues.keys()).sort().map((digest) => `${ JSON.stringify(digest) }:${ JSON.stringify(sharedValues.get(digest)) }`).join(',\n') }\n}\n`

// Writes the given fixtures, which must be the whole fixture set, and the shared values recomputed from them.
export const writeGovernanceFixtures = async (fixtures: ReadonlyMap<string, GovernanceFixture>) => {
	const { sharedFixtures, sharedValues } = shareRepeatedValues(fixtures)
	await fs.mkdir(FIXTURE_DIRECTORY, { recursive: true })
	for (const [name, fixture] of sharedFixtures) await fs.writeFile(new URL(`${ name }.json`, FIXTURE_DIRECTORY), formatFixture(fixture))
	await fs.writeFile(SHARED_VALUES_FILE, formatSharedValues(sharedValues))
}
