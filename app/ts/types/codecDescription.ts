import type * as funtypes from 'funtypes'

// The part of a funtypes codec that every codec exposes. Tag-specific reflection members such as `fields` or `alternatives` are read through the runtime-validated accessors in funtypesFailureExplanation.ts.
export type ReflectedCodec = {
	readonly tag: string
	safeParse(value: unknown): funtypes.Result<unknown>
}

// A JSON document held in a string. It is plain data like the rest of a CodecDescription, so type modules describe their codecs without loading the adapter that reads these descriptions into every extension page.
export type JsonDocumentDescription = {
	readonly name: string
	readonly shape: string
	readonly codec: ReflectedCodec
	readonly parse: (text: string) => unknown
}

// How readable errors name a codec and describe the values it accepts. Each description is defined beside the codec it describes.
export type CodecDescription = {
	readonly codec: ReflectedCodec
	readonly label: string
	// Codecs with an expectation are reported as a whole instead of being inspected structurally.
	readonly expected?: string
	// Strings that hold a JSON document are explained inside the decoded document.
	readonly jsonDocument?: JsonDocumentDescription
}
