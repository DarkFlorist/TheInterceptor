import * as assert from 'assert'
import { readdirSync, readFileSync, statSync } from 'fs'
import * as path from 'path'
import { test } from 'bun:test'

const sourceRoot = path.resolve(import.meta.dir, '../../app/ts')
const routeOwner = 'utils/managementLocation.ts'
const locationAccess = /location\.hash|['"]hashchange['"]|history\.(?:replaceState|pushState)|location\.replace\(/u

function listSourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const fullPath = path.join(directory, entry)
		if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath)
		return /\.tsx?$/u.test(entry) ? [fullPath] : []
	})
}

test('only the management location module reads or writes the location hash', () => {
	const sourceFiles = listSourceFiles(sourceRoot).map((file) => path.relative(sourceRoot, file).split(path.sep).join('/'))
	assert.ok(sourceFiles.includes(routeOwner), `${ routeOwner } is missing`)

	const otherOwners = sourceFiles.filter((file) => file !== routeOwner && locationAccess.test(readFileSync(path.join(sourceRoot, file), 'utf8')))

	assert.deepEqual(otherOwners, [], 'Route state belongs to the management shell: read and change it through managementLocation.ts and pass it to panels as props.')
})
