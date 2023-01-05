export const RED = '\x1b[31m'
export const GREEN = '\x1b[32m'
export const RESET = '\x1b[0m'

export interface TestCase {
	testFunction: () => unknown,
	expectedValue: unknown,
	testName: string,
}

function runTestCase(testCase: TestCase) {
	try {
		let result = testCase.testFunction()
		if (result === testCase.expectedValue) {
			console.log(`\t${ GREEN }√ ${ testCase.testName }${ RESET }`)
			return true
		} else {
			console.error(`\t${ RED }X ${ testCase.testName }: Expected ${ testCase.expectedValue } but got ${ result }${ RESET }`)
		}
	} catch (error) {
		console.error(`\t${ RED }X: Error ${ testCase.testName }${ RESET }`)
		throw error
	}
	return false
}

export function runTestCases(categoryName: string, testCases: [() => unknown, unknown, string][]) {
	console.log(` --- ${ categoryName } ---`)
	const testsFailed = testCases.map((testCase) => runTestCase({
		testFunction: testCase[0],
		expectedValue: testCase[1],
		testName: testCase[2],
	})).reduce((partialSum, a) => partialSum + (a ? 0 : 1), 0)

	if (testsFailed === 0) {
		console.log(` --- Done ---`)
		return true
	}
	console.log(`${ RED }${ testsFailed } test${ testsFailed > 1 ? 's' : '' } failed!${ RESET }`)
	return false
}
