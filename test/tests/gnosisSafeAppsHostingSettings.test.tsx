import * as assert from 'assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { GnosisSafeAppsHostingSettings } from '../../app/ts/components/subcomponents/GnosisSafeAppsHostingSettings.js'
import { installDomMock } from './domMock.js'

test('Gnosis Safe Apps settings explain native launch, original-tab approvals and unsupported sites', () => {
	const dom = installDomMock()
	try {
		render(h(GnosisSafeAppsHostingSettings, {}), dom.document.body)
		assert.match(dom.document.body.textContent, /Open as Gnosis Safe App/)
		assert.match(dom.document.body.textContent, /real iframe inside an extension page/)
		assert.match(dom.document.body.textContent, /original website tab open/)
		assert.match(dom.document.body.textContent, /normal website permissions and approvals/)
		assert.match(dom.document.body.textContent, /block embedding.*unsupported/)
		assert.doesNotMatch(dom.document.body.textContent, /emulates window.parent|synthetic|up to 10 seconds/)
	} finally { dom.restore() }
})
