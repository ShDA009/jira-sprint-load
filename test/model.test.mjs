import test from 'node:test'
import assert from 'node:assert/strict'
import {Jira} from '../jira-sprint-load/jira.mjs'
import {calculate, capacity, defaultSettings, normalizeIssue, periodFor} from '../jira-sprint-load/model.mjs'

const settings = {...defaultSettings(), zone: 'UTC', subtasks: 'parents'}
const sprint = {id: 1, state: 'future', startDate: '2026-11-23T09:00:00Z',
  endDate: '2026-11-27T17:00:00Z'}
const member = {id: 'a', name: 'Аня', share: 50, week: [0, 8, 8, 8, 8, 8, 0],
  absences: [{from: '2026-11-24', to: '2026-11-24', hours: null},
    {from: '2026-11-25', to: '2026-11-25', hours: 2}]}
const task = (key, extra = {}) => ({
  key, assigneeId: 'a', done: false, subtask: false, hasSubtasks: false,
  original: 8 * 3600, remaining: 2 * 3600, priorSprint: false, ...extra
})

test('applies absences, share, and the 60% factor once', () => {
  const period = periodFor(sprint, settings, new Date())
  assert.equal(capacity(member, settings, period), 9)
})

test('active sprint uses only the remaining period, including remaining hours today', () => {
  const active = {...sprint, state: 'active'}
  const period = periodFor(active, settings, new Date('2026-11-26T13:00:00Z'))
  assert.ok(Math.abs(capacity(member, settings, period) - 3.6) < 1e-9)
  const ended = periodFor(active, settings, new Date('2026-11-29T00:00:00Z'))
  assert.equal(capacity(member, settings, ended), 0)
})

test('ignores old manual capacity values in future and active sprints', () => {
  for (const override of [0, 15, {kind: 'total', hours: 20},
    {kind: 'remaining', hours: 6, at: Date.parse('2026-11-26T13:00:00Z')}]) {
    const config = {...settings, team: [{...member, overrides: {1: override}}]}
    const now = new Date('2026-11-26T13:00:00Z')
    assert.equal(calculate(sprint, [], config, now).members[0].capacity, 9)
    assert.ok(Math.abs(calculate({...sprint, state: 'active'}, [], config, now)
      .members[0].capacity - 3.6) < 1e-9)
    assert.equal(calculate({...sprint, startDate: null}, [], config, now).members[0].capacity, null)
  }
})

test('uses Jira sprint timestamps in the team timezone and ignores old custom dates', () => {
  const local = {...settings, zone: 'Europe/Moscow', factor: 100,
    periods: {1: {start: '2026-12-01', end: '2026-12-02'}}}
  const active = {...sprint, state: 'active', startDate: '2026-11-23T06:00:00Z',
    endDate: '2026-11-23T14:00:00Z'}
  const now = new Date('2026-11-23T11:00:00Z')
  assert.equal(capacity(member, local, periodFor(active, local, now)), 1.5)
  assert.equal(periodFor({...active, startDate: null}, local, now), null)
  assert.equal(periodFor({...active, endDate: null}, local, now), null)
  assert.equal(periodFor({...active, endDate: active.startDate}, local, now), null)
})

test('separates incomplete and exceptional work and keeps the full roster', () => {
  const result = calculate(sprint, [
    task('I-1'), task('I-2', {priorSprint: true}),
    task('I-3', {original: null}), task('I-4', {subtask: true}),
    task('I-5', {done: true}), task('I-6', {assigneeId: null}),
    task('I-7', {assigneeId: 'c'}), task('I-8', {priorSprint: null}),
    task('I-9', {priorSprint: true, remaining: null}), task('I-10', {original: 0})
  ], {...settings, team: [member, {...member, id: 'b', share: 0}]})
  assert.deepEqual(result.members.map(row => [row.known, row.missing, row.items.length, row.capacity]),
    [[18, 2, 6, 9], [0, 0, 0, 0]])
  assert.deepEqual(result.unestimated.items.map(item => item.key), ['I-3', 'I-8'])
  assert.equal(result.unassigned.items[0].key, 'I-6')
  assert.equal(result.outside.items[0].key, 'I-7')
})

test('active uses Remaining Estimate including zero and does not infer from worklogs', () => {
  const active = {...sprint, state: 'active'}
  const issues = [task('I-1'), task('I-2', {remaining: null}), task('I-3', {remaining: 0}),
    task('I-4', {done: true})]
  const config = {...settings, team: [member]}
  const tracked = calculate(active, issues, config).members[0]
  assert.deepEqual([tracked.known, tracked.missing, tracked.items.length], [2, 1, 3])
  const untracked = calculate(active, issues, {...config, remaining: 'untracked'}).members[0]
  assert.deepEqual([untracked.known, untracked.missing, untracked.items.length], [0, 3, 3])
})

test('configurable inclusion follows where estimates are recorded', () => {
  const issues = [task('I-1', {hasSubtasks: true}), task('I-2', {subtask: true})]
  for (const [subtasks, included] of [['parents', ['I-1']], ['leaves', ['I-2']], ['all', ['I-1', 'I-2']]]) {
    const report = calculate(sprint, issues, {...settings, team: [member], subtasks})
    assert.deepEqual(report.members[0].items.map(item => item.key), included)
  }
})

test('normalizes Cloud and Server sprint fields and ignores logged time', () => {
  const fields = {
    summary: 'Test', assignee: {accountId: 'a', key: 'b'}, status: {statusCategory: {key: 'done'}},
    issuetype: {subtask: false}, subtasks: [{id: '5'}],
    timetracking: {originalEstimateSeconds: 3600, timeSpentSeconds: 1200}
  }
  const cloud = normalizeIssue({key: 'I-1', fields: {...fields, customfield_7: [
    {id: 1, state: 'future'}, {id: 2, state: 'closed'}
  ]}}, 1, 'customfield_7')
  assert.deepEqual([cloud.priorSprint, cloud.assigneeId, cloud.done, cloud.hasSubtasks,
    cloud.original, cloud.remaining], [true, 'a', true, true, 3600, null])
  const dc = normalizeIssue({key: 'I-1', fields: {...fields,
    customfield_7: ['Sprint@abcd[id=2,rapidViewId=10,state=CLOSED,name=Past]']
  }}, 1, 'customfield_7')
  assert.equal(dc.priorSprint, true)
  assert.equal(normalizeIssue({key: 'I-2', fields}, 1, null).priorSprint, null)
})

test('Data Center starts a new read when adjacent pages overlap', async () => {
  const jira = new Jira('https://jira.test', 1)
  const reads = []
  jira.get = async (path, {startAt}) => {
    reads.push(startAt)
    const keys = startAt === 0 ? ['A', 'B'] : reads.length === 2 ? ['B', 'D'] : ['C', 'D']
    return {startAt, total: 4, issues: keys.map(key => ({key}))}
  }
  const issues = await jira.pages('/rest/agile/1.0/board/17/sprint/1/issue', 'issues')
  assert.deepEqual(reads, [0, 2, 0, 2])
  assert.deepEqual(issues.map(issue => issue.key), ['A', 'B', 'C', 'D'])
})

test('Data Center rejects a second incomplete read', async () => {
  for (const secondPage of [
    {startAt: 2, total: 4, issues: [{key: 'B'}, {key: 'D'}]},
    {startAt: 2, total: 4, issues: [{key: 'C'}], isLast: true},
    {startAt: 2, total: 3, issues: [{key: 'C'}]},
    {startAt: 3, total: 4, issues: [{key: 'C'}, {key: 'D'}]}
  ]) {
    const jira = new Jira('https://jira.test', 1)
    const reads = []
    jira.get = async (path, {startAt}) => {
      reads.push(startAt)
      return startAt === 0 ? {startAt, total: 4, issues: [{key: 'A'}, {key: 'B'}]} : secondPage
    }
    await assert.rejects(jira.pages('/rest/agile/1.0/board/17/sprint/1/issue', 'issues'),
      /Jira не вернула все страницы/)
    assert.deepEqual(reads, [0, 2, 0, 2])
  }
})
