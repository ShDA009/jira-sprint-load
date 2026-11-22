import test from 'node:test'
import assert from 'node:assert/strict'
import {exportTeam, importTeam} from '../jira-sprint-load/team-file.mjs'

const jira = 'https://jira.example.com'
const member = {id: 'u:1', name: 'Анна', week: [0, 8, 4, 8, 8, 8, 0], share: 65,
  absences: [{from: '2026-12-01', to: '2026-12-02', hours: null},
    {from: '2026-12-07', to: '2026-12-07', hours: 2.5}]}

test('keeps the team across export and import and excludes other settings', () => {
  const contents = exportTeam(jira, [{...member, overrides: {2: 40}}])
  assert.deepEqual(importTeam(contents, jira), [member])
  assert.deepEqual(importTeam(exportTeam(jira, []), jira), [])
  assert.throws(() => importTeam(contents, 'https://jira.other.example'), /другой Jira/)
})

test('rejects invalid file formats and team records', () => {
  const valid = JSON.parse(exportTeam(jira, [member]))
  const read = entries => importTeam(JSON.stringify({...valid, team: entries}), jira)
  assert.throws(() => importTeam('broken', jira), /JSON/)
  assert.throws(() => importTeam(JSON.stringify({...valid, version: 2}), jira), /формат/i)
  assert.throws(() => read([member, member]), /повторяется/)
  assert.throws(() => read([{...member, share: 101}]), /график/)
  assert.throws(() => read([{...member, absences: [{from: '2026-02-30', to: '2026-03-03', hours: null}]}]),
    /отсутствия/)
})
