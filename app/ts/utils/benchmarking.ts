export type BenchmarkRpcRequestSample = {
	method: string
	durationMs: number
}

export const BENCHMARK_RPC_REQUESTS_GLOBAL = '__interceptorBenchmarkRpcRequests' as const

type BenchmarkGlobal = typeof globalThis & {
	[BENCHMARK_RPC_REQUESTS_GLOBAL]?: BenchmarkRpcRequestSample[]
}

const benchmarkGlobal = globalThis as BenchmarkGlobal

export function recordBenchmarkRpcRequest(method: string, durationMs: number) {
	const samples = benchmarkGlobal[BENCHMARK_RPC_REQUESTS_GLOBAL]
	if (samples === undefined) return
	samples.push({ method, durationMs })
}
