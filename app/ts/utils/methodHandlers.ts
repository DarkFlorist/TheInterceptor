type MethodValue = { readonly method: string }

export function hasOwnKey<ObjectType extends object>(value: ObjectType, key: PropertyKey): key is keyof ObjectType {
	return Object.prototype.hasOwnProperty.call(value, key)
}

function hasMethod<Union extends MethodValue, Method extends Union['method']>(
	value: Union,
	method: Method,
): value is Extract<Union, { readonly method: Method }> {
	return value.method === method
}

export function createMethodHandlerFor<Union extends MethodValue, Context, Result>() {
	return <Method extends Union['method']>(
		method: Method,
		handler: (context: Context, value: Extract<Union, { readonly method: Method }>) => Result,
	) => (context: Context, value: Union): Result => {
		if (!hasMethod(value, method)) throw new Error(`Handler for ${ method } received ${ value.method }.`)
		return handler(context, value)
	}
}
