declare module 'bun:test' {
	export function describe(name: string, fn: () => void): void
	export function test(name: string, fn: () => unknown | Promise<unknown>): void
	export function test(name: string, options: { timeout?: number }, fn: () => unknown | Promise<unknown>): void
	export function afterEach(fn: () => unknown | Promise<unknown>): void
	export function afterAll(fn: () => unknown | Promise<unknown>): void
}
