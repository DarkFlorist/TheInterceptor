import { useState } from 'preact/hooks'
import { isRecord } from '../../utils/runtimeTypeGuards.js'

function TypedDataValue({ value, path }: { value: unknown, path: string }) {
	const [expanded, setExpanded] = useState(false)
	const entries = Array.isArray(value) ? value.map((item: unknown, index): readonly [string, unknown] => [`[${ index }]`, item]) : isRecord(value) ? Object.entries(value) : undefined
	if (entries === undefined) return <span class = 'signing-field-value'>{ typeof value === 'string' && value === '' ? '""' : String(value) }</span>
	const description = Array.isArray(value) ? `Array · ${ entries.length } ${ entries.length === 1 ? 'item' : 'items' }` : `Struct · ${ entries.length } ${ entries.length === 1 ? 'field' : 'fields' }`
	return <details class = 'signing-field-group' onToggle = { (event) => setExpanded(event.currentTarget.open) }>
		<summary aria-label = { `${ path }: ${ description }` }>{ description }</summary>
		{ expanded ? <TypedDataEntries entries = { entries } path = { path }/> : undefined }
	</details>
}

function TypedDataEntries({ entries, path }: { entries: readonly (readonly [string, unknown])[], path: string }) {
	return <dl class = 'signing-fields'>{ entries.map(([name, value]) => <div key = { name }><dt>{ name }</dt><dd><TypedDataValue value = { value } path = { path === '' ? name : `${ path } → ${ name }` }/></dd></div>) }</dl>
}

/** Native disclosures keep large structs and arrays navigable without changing signed values. */
export function TypedDataFields({ fields }: { fields: Readonly<Record<string, unknown>> }) {
	return <TypedDataEntries entries = { Object.entries(fields) } path = ''/>
}
