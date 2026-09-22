/** Preserve field names and exact scalar values; nested structures retain their JSON shape. */
export function TypedDataFields({ fields }: { fields: Readonly<Record<string, unknown>> }) {
	return <dl class = 'signing-fields'>{ Object.entries(fields).map(([name, value]) => <div key = { name }><dt>{ name }</dt><dd>{ typeof value === 'object' ? <pre>{ JSON.stringify(value, undefined, 2) }</pre> : <span class = 'signing-field-value'>{ typeof value === 'string' ? value === '' ? '""' : value : String(value) }</span> }</dd></div>) }</dl>
}
