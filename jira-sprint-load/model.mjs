const DAY_MS = 86_400_000
const MINUTE_SECONDS = 60
const HOUR_SECONDS = 3600

export const DEFAULT_WEEK = [0, 8, 8, 8, 8, 8, 0]

export function defaultSettings() {
  return {
    base: '', boardId: null, boardName: '', factor: 60,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone, start: '09:00',
    subtasks: '', remaining: 'tracked', team: []
  }
}

export function canonicalBase(value) {
  const url = new URL(value.trim())
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) {
    throw new Error('Укажите базовый адрес Jira, включая контекстный путь, если он есть.')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function withinBase(value, base) {
  if (!value || !base) return false
  try {
    const page = new URL(value)
    const jira = new URL(base)
    const path = jira.pathname.replace(/\/+$/, '')
    return page.origin === jira.origin &&
      (page.pathname === path || page.pathname.startsWith(path + '/'))
  } catch {
    return false
  }
}

function calendarMoment(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(({type, value}) => [type, value]))
  return {
    day: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS,
    seconds: Number(parts.hour) * HOUR_SECONDS + Number(parts.minute) * MINUTE_SECONDS +
      Number(parts.second)
  }
}

function dayNumber(date) {
  if (!date) return null
  const number = Date.parse(date + 'T00:00:00Z')
  return Number.isFinite(number) ? number / DAY_MS : null
}

function compareMoments(left, right) {
  return left.day - right.day || left.seconds - right.seconds
}

function laterMoment(left, right) {
  return compareMoments(left, right) > 0 ? left : right
}

export function periodFor(sprint, settings, now) {
  const zone = settings.zone
  const startDate = Date.parse(sprint.startDate)
  const endDate = Date.parse(sprint.endDate)
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate) || endDate <= startDate) return null
  const start = calendarMoment(startDate, zone)
  const end = calendarMoment(endDate, zone)
  return {
    start: sprint.state === 'active' ? laterMoment(calendarMoment(now, zone), start) : start,
    end
  }
}

function scheduledHours(member, settings, {start, end}) {
  const [hour, minute] = settings.start.split(':').map(Number)
  const dayStart = hour * HOUR_SECONDS + minute * MINUTE_SECONDS
  const absences = member.absences.map(absence => ({
    ...absence, from: dayNumber(absence.from), to: dayNumber(absence.to)
  }))
  let available = 0
  for (let day = start.day; day <= end.day; day++) {
    const weekday = new Date(day * DAY_MS).getUTCDay()
    const dayEnd = dayStart + member.week[weekday] * HOUR_SECONDS
    const from = day === start.day ? Math.max(dayStart, start.seconds) : dayStart
    const to = day === end.day ? Math.min(dayEnd, end.seconds) : dayEnd
    const scheduled = Math.max(0, to - from) / HOUR_SECONDS
    if (!scheduled) continue
    const absent = absences.filter(item => day >= item.from && day <= item.to)
      .reduce((total, item) => total + (item.hours ?? scheduled), 0)
    available += Math.max(0, scheduled - absent)
  }
  return available
}

export function capacity(member, settings, period) {
  if (!period) return null
  return scheduledHours(member, settings, period) * member.share / 100 * settings.factor / 100
}

function validSeconds(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function estimate(issue, sprint, policy) {
  if (sprint.state === 'active') return policy === 'tracked' ? issue.remaining : null
  if (issue.priorSprint === null) return null
  if (issue.priorSprint && policy === 'tracked' && issue.remaining !== null) return issue.remaining
  if (issue.priorSprint && policy !== 'tracked') return null
  return issue.original
}

function group() {
  return {items: [], known: 0, missing: 0}
}

function add(group, task) {
  group.items.push(task)
  if (task.hours === null) group.missing++
  else group.known += task.hours
}

export function calculate(sprint, issues, settings, now = new Date()) {
  const period = periodFor(sprint, settings, now)
  const members = settings.team.map(member => ({
    member, capacity: capacity(member, settings, period), ...group()
  }))
  const byId = new Map(members.map(row => [row.member.id, row]))
  const unassigned = group()
  const outside = group()
  const unestimated = group()
  for (const issue of issues) {
    if (issue.done || (settings.subtasks === 'parents' && issue.subtask) ||
        (settings.subtasks === 'leaves' && issue.hasSubtasks)) continue
    const seconds = estimate(issue, sprint, settings.remaining)
    const task = {...issue, hours: seconds === null ? null : seconds / HOUR_SECONDS}
    const row = issue.assigneeId ? byId.get(issue.assigneeId) ?? outside : unassigned
    add(row, task)
    if (task.hours === null) add(unestimated, task)
  }
  return {members, unassigned, outside, unestimated, hasPeriod: Boolean(period)}
}

function isClosed(entry, sprintId) {
  if (typeof entry === 'string') {
    const id = entry.match(/(?:\[|,)id=(\d+)(?=,|\])/)?.[1]
    return id !== undefined && id !== String(sprintId) && /(?:\[|,)state=CLOSED(?=,|\])/i.test(entry)
  }
  return entry?.id != null && String(entry.id) !== String(sprintId) &&
    String(entry.state).toLowerCase() === 'closed'
}

export function normalizeIssue(issue, sprintId, sprintField) {
  const fields = issue.fields ?? {}
  const sprints = sprintField && Array.isArray(fields[sprintField]) ? fields[sprintField] : null
  const closed = Array.isArray(fields.closedSprints) ? fields.closedSprints : null
  const timed = fields.timetracking ?? {}
  const user = fields.assignee
  const status = fields.status?.statusCategory?.key
  if (!status || !Object.hasOwn(fields, 'assignee') ||
      !Object.hasOwn(fields, 'subtasks') || !Object.hasOwn(fields, 'issuetype') ||
      typeof fields.issuetype?.subtask !== 'boolean') {
    throw new Error('Jira не вернула исполнителя, категорию статуса или сведения о подзадачах.')
  }
  return {
    key: issue.key, title: fields.summary ?? issue.key,
    assigneeId: user?.accountId || user?.key || user?.name || null,
    assigneeName: user?.displayName || user?.name || '',
    done: status.toLowerCase() === 'done', subtask: fields.issuetype.subtask,
    hasSubtasks: Array.isArray(fields.subtasks) && fields.subtasks.length > 0,
    original: validSeconds(fields.timeoriginalestimate ?? timed.originalEstimateSeconds),
    remaining: validSeconds(fields.timeestimate ?? timed.remainingEstimateSeconds),
    priorSprint: sprints || closed
      ? Boolean(closed?.some(entry => String(entry?.id) !== String(sprintId)) ||
          sprints?.some(entry => isClosed(entry, sprintId)))
      : null
  }
}
