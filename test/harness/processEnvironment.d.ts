// Environment variables read by Bun-run tests, benchmarks and scripts. Declaring them lets code use `process.env.NAME` under `noPropertyAccessFromIndexSignature` without bracket access, which Biome's useLiteralKeys rejects. Add new variables here instead of reading them through an index signature.
declare global {
	namespace NodeJS {
		interface ProcessEnv {
			BENCH_ITERATIONS?: string
			BENCH_RPC_DELAY_MS?: string
			BENCH_SCENARIO?: string
			BENCH_WALLET_DELAY_MS?: string
			CHROME_BIN?: string
			CHROME_LOG_FILE?: string
			CHROME_PATH?: string
			CHROME_USER_DATA_DIR?: string
			CHROMIUM_BIN?: string
			CHROMIUM_PATH?: string
			DISPLAY?: string
			FIREFOX_BIN?: string
			GECKODRIVER_BIN?: string
			GOOGLE_CHROME_BIN?: string
			INTERCEPTOR_CHROME_PROFILE_DIR?: string
			INTERCEPTOR_CONTENT_SCRIPT_RECONNECT_TEST_CHILD?: string
			PATH?: string
			SAFE_UI_EXTENSION_DIRECTORY?: string
			SAFE_UI_SCREENSHOT_BROWSER?: string
			SAFE_UI_SCREENSHOT_OUTPUT_DIRECTORY?: string
		}
	}
}

export {}
