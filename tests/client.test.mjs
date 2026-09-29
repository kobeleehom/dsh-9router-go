import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DASHBOARD_URL = 'http://127.0.0.1:20130/'

/**
 * Execute the shipped browser bundle the way the page's module loader does: a
 * classic script that registers one factory, then a factory call.
 * @param requireStub - what the bundle receives in place of the module table.
 * @returns the registered row id and the factory's exports.
 */
async function loadBundle(requireStub = () => { throw new Error('bundle must not require any module') }) {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  const rows = []
  const window = { __ModuleLoader__: { load: row => rows.push(row) } }
  new Function('window', source)(window)
  assert.equal(rows.length, 1, 'the bundle must register exactly one module row')
  const row = rows[0]
  assert.equal(row.id, 'dsh-9router-go', 'the row id must equal the package name the boot graph uses')
  return { row, exports: row.factory(requireStub) }
}

function harness({ browserTab = true } = {}) {
  const registrations = []
  const opened = []
  const effects = []
  const registry = { get: kind => (browserTab && kind === 'browser' ? { id: 'browser' } : undefined) }
  const ctx = {
    // Cordis runs the effect callback immediately and keeps its return value as the disposer.
    effect: (register) => { effects.push(register()); return () => {} },
    get: name => (name === 'sidebarRightTabs' ? registry : undefined),
    commandUi: { register: (contribution) => { registrations.push(contribution); return () => {} } },
    sidebarRight: { openTab: (kind, options) => { opened.push({ kind, options }) } },
  }
  return { ctx, registrations, opened, effects }
}

test('registers one reversible dashboard command that opens the sidebar Browser', async () => {
  const { row, exports } = await loadBundle()
  assert.deepEqual(exports.inject, ['commandUi', 'sidebarRight'])
  assert.equal(typeof exports.apply, 'function')
  const h = harness()
  exports.apply(h.ctx)
  assert.equal(h.effects.length, 1, 'the command must be registered through one effect')
  assert.equal(h.registrations.length, 1)
  const command = h.registrations[0]
  assert.equal(command.name, '9router-go')
  assert.equal(command.ui.kind, 'action')
  assert.equal(typeof command.description(), 'string')
  assert.equal(command.available({}), true)
  command.ui.run({})
  assert.deepEqual(h.opened, [{ kind: 'browser', options: { params: { url: DASHBOARD_URL } } }])
  assert.equal(row.url, undefined, 'the boot row is host-composed, not declared here')
})

test('stays unavailable where no Browser tab type is mounted', async () => {
  const { exports } = await loadBundle()
  const h = harness({ browserTab: false })
  exports.apply(h.ctx)
  assert.equal(h.registrations[0].available({}), false)
})

test('the bundle depends on no module table entry', async () => {
  const { exports } = await loadBundle()
  const h = harness()
  exports.apply(h.ctx)
  h.registrations[0].ui.run({})
  assert.equal(h.opened.length, 1)
})
