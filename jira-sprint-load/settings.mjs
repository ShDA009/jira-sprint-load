import {DEFAULT_WEEK, canonicalBase} from './model.mjs'
import {Jira, jiraTab, permissionFor} from './jira.mjs'
import {exportTeam, importTeam} from './team-file.mjs'
import {byId as $, el, button, hours} from './view.mjs'

const WEEK_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const dialog = $('editor')
let original
let draft
let readWindowId
let commit
let connection
let granted
let token = 0
let busy = false
let teamBase
let pendingTeam

function options(boards, selected) {
  const input = $('boards')
  input.replaceChildren(new Option('Выберите доску', ''))
  for (const board of boards) input.add(new Option(board.name, board.id))
  input.value = selected ?? ''
  $('sample').disabled = !input.value
}

function field(text, type, value, update, constraints = {}) {
  const wrapper = el('div')
  const label = el('label', text)
  const input = el('input')
  input.type = type
  input.id = crypto.randomUUID()
  input.value = value ?? ''
  Object.assign(input, constraints)
  input.addEventListener('input', () => {
    update(type === 'number' ? (input.value === '' ? null : input.valueAsNumber) : input.value)
  })
  label.htmlFor = input.id
  wrapper.append(label, input)
  return wrapper
}

function editAbsences(member, container) {
  const parts = member.absences.map((absence, index) => {
    const row = el('div', null, 'absence')
    row.append(
      field('С', 'date', absence.from, value => { absence.from = value }, {required: true}),
      field('По', 'date', absence.to, value => { absence.to = value }, {required: true}),
      field('Часов в день', 'number', absence.hours, value => { absence.hours = value },
        {min: 0, max: 24, step: 'any', placeholder: 'Весь день'}),
      button('Удалить', () => {
        member.absences.splice(index, 1)
        editAbsences(member, container)
      })
    )
    return row
  })
  container.replaceChildren(...parts, button('Добавить отсутствие', () => {
    member.absences.push({from: '', to: '', hours: null})
    editAbsences(member, container)
  }))
}

function addMemberCard(member) {
  const card = el('details', null, 'team-card')
  card.dataset.id = member.id
  const content = el('div', null, 'team-fields')
  const week = el('div', null, 'week')
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    week.append(field(WEEK_LABELS[day], 'number', member.week[day], value => {
      member.week[day] = value
    }, {min: 0, max: 24, step: 'any', required: true}))
  }
  content.append(field('Участие в команде, %', 'number', member.share, value => {
    member.share = value
  }, {min: 0, max: 100, step: 'any', required: true}), el('p', 'Рабочих часов в день', 'help'), week)
  const absences = el('div', null, 'absences')
  editAbsences(member, absences)
  content.append(absences, button('Убрать участника', () => {
    draft.team = draft.team.filter(item => item.id !== member.id)
    card.remove()
  }))
  card.append(el('summary', member.name), content)
  $('team-edit').append(card)
  return card
}

function showUsers(users) {
  const results = $('user-results')
  const available = users.filter(user => !draft.team.some(member => member.id === user.id))
  results.replaceChildren(...available.map(user => {
    const action = button(user.name + ' · ' + user.id, () => {
      if (draft.team.some(member => member.id === user.id)) return
      const member = {...user, week: [...DEFAULT_WEEK], share: 100, absences: []}
      draft.team.push(member)
      addMemberCard(member).open = true
      action.remove()
    })
    action.classList.add('user-option')
    return action
  }))
  if (!available.length) results.append(el('p', 'Новых участников не найдено.', 'help'))
}

function clearTeamTransfer() {
  pendingTeam = null
  $('team-file').value = ''
  $('team-import-confirm').hidden = true
  report($('team-transfer-status'), '')
}

function draftTeamBase() {
  if (!connection || connection.base !== teamBase) {
    throw new Error('Сначала проверьте подключение к Jira.')
  }
  return teamBase
}

function downloadTeam() {
  clearTeamTransfer()
  const status = $('team-transfer-status')
  try {
    const contents = exportTeam(draftTeamBase(), draft.team)
    const url = URL.createObjectURL(new Blob([contents], {type: 'application/json'}))
    const link = el('a')
    link.href = url
    link.download = 'jira-team.json'
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    report(status, 'Файл команды передан в загрузки Chrome.')
  } catch (error) {
    showError(status, error)
  }
}

async function readTeamFile() {
  const file = $('team-file').files[0]
  if (!file) return
  clearTeamTransfer()
  const status = $('team-transfer-status')
  setBusy(true)
  try {
    const base = draftTeamBase()
    const contents = await file.text()
    pendingTeam = importTeam(contents, base)
    report(status, 'В файле участников: ' + pendingTeam.length +
      '. Импорт заменит состав команды в настройках.')
    $('team-import-confirm').hidden = false
  } catch (error) {
    showError(status, error)
  } finally {
    setBusy(false)
  }
}

function applyTeamFile() {
  if (busy || !pendingTeam) return
  draft.team = pendingTeam
  clearTeamTransfer()
  $('user-results').replaceChildren()
  $('team-edit').replaceChildren()
  for (const member of draft.team) addMemberCard(member)
  report($('team-transfer-status'), 'Команда загружена. Нажмите «Сохранить настройки», чтобы применить.')
}

function setBusy(value) {
  busy = value
  for (const id of ['connect', 'find-user', 'save', 'boards', 'jira-base']) $(id).disabled = value
  $('sample').disabled = value || !$('boards').value
  $('team-import').disabled = value || !connection
  $('team-export').disabled = value || !connection
  $('team-import-apply').disabled = value
}

function showError(target, error) {
  target.textContent = error.message
  target.hidden = false
  target.classList.add('error')
}

function report(target, text) {
  target.textContent = text
  target.classList.remove('error')
}

async function tryConnection() {
  if (!$('jira-base').reportValidity()) return
  const myToken = ++token
  setBusy(true)
  report($('connection'), 'Проверяем подключение…')
  try {
    const base = canonicalBase($('jira-base').value)
    const origin = permissionFor(base)
    const allowed = await chrome.permissions.request({origins: [origin]})
    if (myToken !== token) {
      if (allowed && (!original.base || permissionFor(original.base) !== origin)) {
        await chrome.permissions.remove({origins: [origin]})
      }
      return
    }
    if (!allowed) throw new Error('Chrome не предоставил доступ к указанному адресу.')
    const precedingGrant = granted
    granted = !original.base || permissionFor(original.base) !== origin ? origin : null
    if (precedingGrant && precedingGrant !== granted) {
      await chrome.permissions.remove({origins: [precedingGrant]})
    }
    const tab = await jiraTab(base, readWindowId)
    const jira = new Jira(base, tab.id)
    const info = await jira.inspect()
    if (myToken !== token) return
    if (teamBase && base !== teamBase) {
      draft.team = []
      $('team-edit').replaceChildren()
    }
    teamBase = base
    connection = {base, ...info}
    options(info.boards, base === original.base ? original.boardId : null)
    report($('connection'), info.server + ' · Scrum-досок: ' + info.boards.length)
  } catch (error) {
    if (myToken === token) showError($('connection'), error)
  } finally {
    if (myToken === token) setBusy(false)
  }
}

async function withJira(target, action) {
  if (busy) return
  if (!connection) {
    showError(target, new Error('Сначала проверьте подключение к Jira.'))
    return
  }
  const myToken = ++token
  setBusy(true)
  report(target, 'Загружаем данные…')
  try {
    const tab = await jiraTab(connection.base, readWindowId)
    const result = await action(new Jira(connection.base, tab.id))
    if (myToken === token) result()
  } catch (error) {
    if (myToken === token) showError(target, error)
  } finally {
    if (myToken === token) setBusy(false)
  }
}

function validate() {
  new Intl.DateTimeFormat('ru', {timeZone: $('zone').value.trim()})
  const [hour, minute] = $('start').value.split(':').map(Number)
  const maxHours = 24 - hour - minute / 60
  for (const member of draft.team) {
    if (member.week.some(value => value > maxHours)) {
      throw new Error(member.name + ' · рабочий день должен заканчиваться до полуночи.')
    }
    if (member.absences.some(absence => absence.from > absence.to)) {
      throw new Error(member.name + ' · окончание отсутствия раньше начала.')
    }
  }
}

async function save(event) {
  event.preventDefault()
  if (busy) return
  const error = $('save-error')
  error.hidden = true
  try {
    const base = canonicalBase($('jira-base').value)
    if (connection?.base !== base) throw new Error('Проверьте подключение перед сохранением.')
    try {
      validate()
    } catch (failure) {
      if (failure instanceof RangeError) throw new Error('Укажите часовой пояс IANA, например Europe/Moscow.')
      throw failure
    }
    const board = connection.boards.find(item => String(item.id) === $('boards').value)
    if (!board) throw new Error('Выберите Scrum-доску.')
    delete draft.periods
    for (const member of draft.team) delete member.overrides
    const oldOrigin = original.base && permissionFor(original.base)
    setBusy(true)
    const updated = {
      ...draft, base, boardId: board.id, boardName: board.name,
      server: connection.server, cloud: connection.cloud, sprintField: connection.sprintField ?? null,
      factor: $('factor').valueAsNumber, zone: $('zone').value.trim(), start: $('start').value,
      subtasks: $('subtasks').value, remaining: $('remaining').value
    }
    await commit(updated)
    granted = null
    dialog.close()
    if (oldOrigin && oldOrigin !== permissionFor(base)) {
      await chrome.permissions.remove({origins: [oldOrigin]})
    }
  } catch (failure) {
    showError(error, failure)
  } finally {
    setBusy(false)
  }
}

export function openSettings(settings, windowId, onSave) {
  original = settings
  draft = structuredClone(settings)
  teamBase = settings.base
  readWindowId = windowId
  commit = onSave
  connection = settings.base ? {
    base: settings.base, boards: [{id: settings.boardId, name: settings.boardName}],
    server: settings.server, cloud: settings.cloud, sprintField: settings.sprintField
  } : null
  $('jira-base').value = settings.base
  $('subtasks').value = settings.subtasks
  $('remaining').value = settings.remaining
  $('factor').value = settings.factor
  $('start').value = settings.start
  $('zone').value = settings.zone
  $('user-query').value = ''
  $('user-results').replaceChildren()
  $('team-edit').replaceChildren()
  for (const member of draft.team) addMemberCard(member)
  report($('connection'), settings.server ?? '')
  report($('sample-result'), '')
  clearTeamTransfer()
  $('save-error').hidden = true
  options(connection?.boards ?? [], settings.boardId)
  setBusy(false)
  dialog.showModal()
}

$('cancel').addEventListener('click', () => { if (!busy) dialog.close() })
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() })
dialog.addEventListener('close', () => {
  token++
  if (granted) chrome.permissions.remove({origins: [granted]}).catch(console.error)
  granted = null
})
$('settings-form').addEventListener('submit', save)
$('settings-form').addEventListener('invalid', event => {
  const card = event.target.closest('.team-card')
  if (card) card.open = true
}, true)
$('connect').addEventListener('click', () => {
  clearTeamTransfer()
  tryConnection()
})
$('team-import').addEventListener('click', () => $('team-file').click())
$('team-file').addEventListener('change', readTeamFile)
$('team-import-apply').addEventListener('click', applyTeamFile)
$('team-import-cancel').addEventListener('click', clearTeamTransfer)
$('team-export').addEventListener('click', downloadTeam)
$('jira-base').addEventListener('input', () => {
  options([], '')
  report($('connection'), '')
  report($('sample-result'), '')
  connection = null
  clearTeamTransfer()
  setBusy(false)
})
$('boards').addEventListener('change', () => {
  $('sample').disabled = !$('boards').value
  report($('sample-result'), '')
})
$('sample').addEventListener('click', () => withJira($('sample-result'), async jira => {
  const boardId = $('boards').value
  const sprints = await jira.sprints(boardId)
  const sprint = sprints.find(item => item.state === 'active') ?? sprints[0]
  if (!sprint) return () => report($('sample-result'), 'На доске нет активных или будущих спринтов.')
  const issues = await jira.issues(boardId, sprint, connection.sprintField, connection.cloud)
  const open = issues.filter(item => !item.done)
  const original = open.filter(item => item.original !== null).length
  const remaining = open.filter(item => item.remaining !== null).length
  const parents = open.filter(item => item.hasSubtasks && (item.original !== null || item.remaining !== null)).length
  const children = open.filter(item => item.subtask && (item.original !== null || item.remaining !== null)).length
  const backlogUnknown = open.filter(item => item.priorSprint === null).length
  const total = open.reduce((sum, item) => sum + (item.remaining ?? 0), 0)
  return () => report($('sample-result'),
    sprint.name + ' · открытых задач: ' + open.length + '. Original Estimate: ' + original +
    '. Remaining Estimate: ' + remaining + ' (' + hours(total / 3600) + '). С оценкой: родителей ' +
    parents + ', подзадач ' + children + '. Задач без сведений о прошлых спринтах: ' + backlogUnknown + '.')
}))
function searchUsers() {
  const query = $('user-query').value.trim()
  if (!query) return
  withJira($('user-results'), async jira => {
    const users = await jira.users(query, connection.cloud)
    return () => {
      $('user-results').classList.remove('error')
      showUsers(users)
    }
  })
}
$('find-user').addEventListener('click', searchUsers)
$('user-query').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    searchUsers()
  }
})
