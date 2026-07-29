import * as assert from 'assert'
import { test } from 'bun:test'
import { collectMultilineNamedImportDiagnostics } from '../../scripts/check-single-line-imports.mts'

test('single-line import lint reports only multiline named imports', () => {
	const sourceText = [
		'import DefaultImport, { first, type Second } from \'./single-line.js\'',
		'import {',
		'\tthird,',
		'\tfourth,',
		'} from \'./multiline.js\'',
		'import DefaultOnly from \'./default.js\'',
		'import \'./side-effect.js\'',
		'',
	].join('\n')

	assert.deepEqual(collectMultilineNamedImportDiagnostics('fixture.ts', sourceText), [{
		file: 'fixture.ts',
		line: 2,
		column: 8,
	}])
})
