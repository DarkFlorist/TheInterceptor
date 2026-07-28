import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { isValidEnsName, normalizeEnsNameOrUndefined } from '../../app/ts/utils/ens.js'

describe('ENS normalization helpers', () => {
	test('normalizes accepted names before ENS resolution and storage validation', () => {
		assert.equal(normalizeEnsNameOrUndefined('BÜCHER.eth'), 'bücher.eth')
		assert.equal(normalizeEnsNameOrUndefined('mañana.eth'), 'mañana.eth')
		assert.equal(normalizeEnsNameOrUndefined('ＡＢＣ.eth'), 'abc.eth')
		assert.equal(normalizeEnsNameOrUndefined('abc中文.eth'), 'abc中文.eth')
		assert.equal(normalizeEnsNameOrUndefined('中文abc.eth'), '中文abc.eth')
		assert.equal(normalizeEnsNameOrUndefined('abc한글.eth'), 'abc한글.eth')
		assert.equal(normalizeEnsNameOrUndefined('emoji❤️.eth'), 'emoji❤.eth')
		assert.equal(normalizeEnsNameOrUndefined('\u2615\ufe0e.eth'), '☕.eth')
		assert.equal(normalizeEnsNameOrUndefined('\u2764\ufe0e.eth'), '❤.eth')
		assert.equal(normalizeEnsNameOrUndefined('\u2764\ufe0f\ufe0e.eth'), '❤.eth')
		assert.equal(normalizeEnsNameOrUndefined('🏳️‍🌈.eth'), '🏳‍🌈.eth')
		assert.equal(normalizeEnsNameOrUndefined('👩‍❤️‍👩.eth'), '👩‍❤‍👩.eth')
		assert.equal(normalizeEnsNameOrUndefined('👨‍👦.eth'), '👨‍👦.eth')
		assert.equal(normalizeEnsNameOrUndefined('🧑🏽.eth'), '🧑🏽.eth')
		assert.equal(normalizeEnsNameOrUndefined('😀--a.eth'), '😀--a.eth')
		assert.equal(normalizeEnsNameOrUndefined('—.eth'), '-.eth')
			assert.equal(normalizeEnsNameOrUndefined('™.eth'), 'tm.eth')
			assert.equal(normalizeEnsNameOrUndefined('①.eth'), '1.eth')
			assert.equal(normalizeEnsNameOrUndefined('⑪.eth'), '11.eth')
			assert.equal(normalizeEnsNameOrUndefined('⁴.eth'), '4.eth')
			assert.equal(normalizeEnsNameOrUndefined('₂.eth'), '2.eth')
			assert.equal(normalizeEnsNameOrUndefined('¼.eth'), '1⁄4.eth')
			assert.equal(normalizeEnsNameOrUndefined('⅐.eth'), '1⁄7.eth')
			assert.equal(normalizeEnsNameOrUndefined('⁃.eth'), '-.eth')
			assert.equal(normalizeEnsNameOrUndefined('﹘.eth'), '-.eth')
			assert.equal(normalizeEnsNameOrUndefined('۱۲۳.eth'), '١٢٣.eth')
			assert.equal(normalizeEnsNameOrUndefined('۴۵۶.eth'), '۴۵۶.eth')
			assert.equal(normalizeEnsNameOrUndefined('۰۱۲۳۴۵۶۷۸۹.eth'), '٠١٢٣۴۵۶٧٨٩.eth')
			assert.equal(normalizeEnsNameOrUndefined('مرحبا۱۲۳.eth'), 'مرحبا١٢٣.eth')
			assert.equal(normalizeEnsNameOrUndefined('مرحبا۴۵۶.eth'), 'مرحبا۴۵۶.eth')
			assert.equal(normalizeEnsNameOrUndefined('مِ.eth'), 'مِ.eth')
			assert.equal(normalizeEnsNameOrUndefined('कि.eth'), 'कि.eth')
			assert.equal(normalizeEnsNameOrUndefined('тест.eth'), 'тест.eth')
			assert.equal(normalizeEnsNameOrUndefined('ϲω.eth'), 'σω.eth')
			assert.equal(normalizeEnsNameOrUndefined('ζζ.eth'), 'ζζ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ηη.eth'), 'ηη.eth')
			assert.equal(normalizeEnsNameOrUndefined('ςς.eth'), 'ςς.eth')
			assert.equal(normalizeEnsNameOrUndefined('τζ.eth'), 'τζ.eth')
			assert.equal(normalizeEnsNameOrUndefined('τη.eth'), 'τη.eth')
			assert.equal(normalizeEnsNameOrUndefined('Π.eth'), 'π.eth')
			assert.equal(normalizeEnsNameOrUndefined('ϖ.eth'), 'π.eth')
			assert.equal(normalizeEnsNameOrUndefined('ππ.eth'), 'ππ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ξ.eth'), 'ξ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ξξ.eth'), 'ξξ.eth')
			assert.equal(normalizeEnsNameOrUndefined('฿.eth'), '฿.eth')
			assert.equal(normalizeEnsNameOrUndefined('⃀.eth'), '⃀.eth')
			assert.equal(normalizeEnsNameOrUndefined('⃁.eth'), '⃁.eth')
			assert.equal(normalizeEnsNameOrUndefined('〄.eth'), '〄.eth')
			assert.equal(normalizeEnsNameOrUndefined('〓.eth'), '〓.eth')
			assert.equal(normalizeEnsNameOrUndefined('〠.eth'), '〠.eth')
			assert.equal(normalizeEnsNameOrUndefined('ｰ.eth'), 'ー.eth')
			assert.equal(normalizeEnsNameOrUndefined('￩.eth'), '←.eth')
			assert.equal(normalizeEnsNameOrUndefined('￪.eth'), '↑.eth')
			assert.equal(normalizeEnsNameOrUndefined('￫.eth'), '→.eth')
			assert.equal(normalizeEnsNameOrUndefined('￬.eth'), '↓.eth')
			assert.equal(normalizeEnsNameOrUndefined('$.eth'), '$.eth')
			assert.equal(normalizeEnsNameOrUndefined('°.eth'), '°.eth')
			assert.equal(normalizeEnsNameOrUndefined('♪.eth'), '♪.eth')
			assert.equal(normalizeEnsNameOrUndefined('♫.eth'), '♫.eth')
			assert.equal(normalizeEnsNameOrUndefined('¤.eth'), '¤.eth')
			assert.equal(normalizeEnsNameOrUndefined('¬.eth'), '¬.eth')
			assert.equal(normalizeEnsNameOrUndefined('_.eth'), '_.eth')
			assert.equal(normalizeEnsNameOrUndefined('__.eth'), '__.eth')
			assert.equal(normalizeEnsNameOrUndefined('__foo.eth'), '__foo.eth')
			assert.equal(normalizeEnsNameOrUndefined('Բ.eth'), 'բ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ܐ.eth'), 'ܐ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ހ.eth'), 'ހ.eth')
			assert.equal(normalizeEnsNameOrUndefined('অ.eth'), 'অ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ਅ.eth'), 'ਅ.eth')
			assert.equal(normalizeEnsNameOrUndefined('અ.eth'), 'અ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ଅ.eth'), 'ଅ.eth')
			assert.equal(normalizeEnsNameOrUndefined('அ.eth'), 'அ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ఈ.eth'), 'ఈ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ಀ.eth'), 'ಀ.eth')
			assert.equal(normalizeEnsNameOrUndefined('അ.eth'), 'അ.eth')
			assert.equal(normalizeEnsNameOrUndefined('අ.eth'), 'අ.eth')
			assert.equal(normalizeEnsNameOrUndefined('༌.eth'), '་.eth')
			assert.equal(normalizeEnsNameOrUndefined('က.eth'), 'က.eth')
			assert.equal(normalizeEnsNameOrUndefined('Ⴧ.eth'), 'ⴧ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ሁ.eth'), 'ሁ.eth')
			assert.equal(normalizeEnsNameOrUndefined('Ꭳ.eth'), 'Ꭳ.eth')
			assert.equal(normalizeEnsNameOrUndefined('ក.eth'), 'ក.eth')
			assert.equal(normalizeEnsNameOrUndefined('᠐.eth'), '᠐.eth')
			assert.equal(normalizeEnsNameOrUndefined('Ẽ.eth'), 'ẽ.eth')
			assert.equal(normalizeEnsNameOrUndefined('Ỳ.eth'), 'ỳ.eth')
			assert.equal(isValidEnsName('_foo.eth'), true)
			assert.equal(isValidEnsName('🧑🏽‍💻.eth'), true)
	})

	test('returns undefined for rejected names used by app-level validators', () => {
		for (const name of [
			'foo..eth',
			'_foo_bar.eth',
			'__foo_bar.eth',
			'foo_.eth',
			'foo_bar.eth',
			'ab--cd.eth',
			'раураl.eth',
			'a\u200db.eth',
			'a\u200d😀.eth',
			'😀\u200da.eth',
			'😀\u200d😀.eth',
			'👦‍👦.eth',
			'👨‍👨.eth',
			'👧‍👦.eth',
			'🏽.eth',
			'🏻.eth',
			'a🏽.eth',
			'\ue000.eth',
			'\ufdd0.eth',
			'\ufffe.eth',
			'!foo.eth',
			'foo%bar.eth',
			'℮.eth',
			'✓.eth',
			'a\u0338.eth',
			'a\u0340.eth',
			'a\u0341.eth',
			'a\u0305.eth',
			'a\u20dd.eth',
			'a\u034f.eth',
			'ª.eth',
			'¹.eth',
			'ǆ.eth',
			'ʰ.eth',
			'ˡ.eth',
			'ʹ.eth',
			'օ.eth',
			'ו.eth',
			'ا.eth',
			'ؿ.eth',
			'⓫.eth',
			'⓿.eth',
				'ϲ.eth',
				'є.eth',
				'ес.eth',
				'раура.eth',
				'❶.eth',
				'β.eth',
				'α.eth',
				'δ.eth',
				'τεστ.eth',
				'τορ.eth',
				'κοτ.eth',
				'σκοτ.eth',
				'εσ.eth',
				'а.eth',
				'±.eth',
				'×.eth',
				'÷.eth',
				'♭.eth',
				'♮.eth',
				'♯.eth',
				'مرحبا1.eth',
				'שלום1.eth',
				'abcمرحبا.eth',
				'abcไทย.eth',
				'abcहिन्दी.eth',
				'०.eth',
				'๐.eth',
				'จ.eth',
				'₠.eth',
				'₢.eth',
				'ࢭ.eth',
				'ࢮ.eth',
				'ऽ.eth',
				'ฯ.eth',
				'︳.eth',
				'︴.eth',
				'々.eth',
				'〻.eth',
				'ￚ.eth',
				'ⱼ.eth',
				'ⱽ.eth',
				'ㇰ.eth',
				'ㇿ.eth',
				'ꚜ.eth',
				'ꚝ.eth',
				'ﬅ.eth',
				'ﬆ.eth',
				'𐅀.eth',
				'𞀲.eth',
				'𛀀.eth',
			] as const) {
			assert.equal(normalizeEnsNameOrUndefined(name), undefined, name)
			assert.equal(isValidEnsName(name), false, name)
		}
	})
})
