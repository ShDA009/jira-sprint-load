import {calculate, defaultSettings, withinBase} from './model.mjs'
import {Jira, jiraTab, observe} from './jira.mjs'
import {openSettings} from './settings.mjs'
import {byId as $, renderRows} from './view.mjs'

const POLL_MS = 15_000
const SAVE_DELAY_MS = 400
const MAX_CACHE = 5
const formatTime = new Intl.DateTimeFormat('ru', {dateStyle: 'short', timeStyle: 'medium'})

let settings = defaultSettings()
let windowId
let selected = ''
let sprints = []
let cache = []
let sourceTabId
let signalTimer
let timer
let retryAt = 0
let queued = false
let running = false
let ready = false
let revision = 0
let saving = false

function snapshot() {
  return cache.find(item => item.id === selected)
}

function applyStatus(message, stale = false) {
  const status = $('status')
  status.textContent = message
  status.classList.toggle('stale', stale)
}

function sprintList(record) {
  const select = $('sprint')
  const options = sprints.map(item => {
    const sprint = String(item.id) === selected ? record?.sprint ?? item : item
    return new Option(sprint.name + (sprint.state === 'active' ? ' · активный' : ' · будущий'), sprint.id)
  })
  const key = JSON.stringify(options.map(option => [option.value, option.text]))
  if (select.dataset.sprints !== key) {
    select.dataset.sprints = key
    select.replaceChildren(...options)
  }
  select.disabled = !options.length
  select.value = selected
}

function render() {
  const configured = Boolean(settings.boardId)
  $('empty').hidden = configured
  $('dashboard').hidden = !configured
  $('board-name').textContent = settings.boardName
  if (!configured) return
  const record = snapshot()
  sprintList(record)
  $('report').hidden = !record
  if (!record) return

  const {sprint, issues, at} = record
  const active = sprint.state === 'active'
  const report = calculate(sprint, issues, settings, new Date(at))
  $('hours-heading').textContent = active ? 'Осталось работы / доступно' : 'Назначено / доступно'
  const notices = []
  if (!report.hasPeriod) notices.push('В Jira нет корректных дат спринта. Ёмкость появится, когда в спринте будут заданы даты начала и окончания.')
  if (!settings.team.length) notices.push('Добавьте участников в настройках.')
  if (active && settings.remaining === 'untracked') {
    notices.push('Команда не поддерживает Remaining Estimate. Остаток работы неизвестен.')
  }
  if (report.unestimated.items.length) {
    notices.push('Часы по задачам без оценки не вошли в итог.')
  }
  $('notice').textContent = notices.join(' ')
  $('notice').hidden = !notices.length
  renderRows($('members'), report.members.map(row => ({id: row.member.id, row})), settings.base, active)
  renderRows($('groups'), [
    {id: 'unassigned', row: report.unassigned, label: 'Без исполнителя'},
    {id: 'outside', row: report.outside, label: 'Исполнители вне команды'},
    {id: 'unestimated', row: report.unestimated, label: 'Без данных об оценке'}
  ], settings.base, active)
}

function showUpdating() {
  const record = snapshot()
  applyStatus(record ? 'Обновляем данные · получены ' + formatTime.format(record.at) :
    'Загружаем данные из Jira…', Boolean(record))
}

function schedule() {
  clearTimeout(timer)
  if (!ready || saving || !settings.boardId) return
  timer = setTimeout(requestRefresh, Math.max(POLL_MS, retryAt - Date.now()))
}

function requestRefresh() {
  if (!ready || saving || !settings.boardId) return
  if (Date.now() < retryAt) {
    schedule()
    return
  }
  queued = true
  if (!running) refresh().catch(console.error)
}

async function refresh() {
  running = true
  try {
    while (queued) {
      queued = false
      clearTimeout(timer)
      await load(revision)
    }
  } finally {
    running = false
    schedule()
  }
}

async function load(expectedRevision) {
  const config = settings
  showUpdating()
  try {
    const tab = await jiraTab(config.base, windowId, sourceTabId)
    if (revision !== expectedRevision) return
    sourceTabId = tab.id
    // Polling is independent of the page observer.
    observe(tab.id, config.base).catch(() => {})
    const jira = new Jira(config.base, tab.id)
    const [visible] = await Promise.all([jira.sprints(config.boardId), jira.verifyAccess(config.boardId)])
    const available = visible
      .filter(item => ['active', 'future'].includes(item.state))
      .map(({id, name, state, startDate, endDate}) => ({id, name, state, startDate, endDate}))
    if (revision !== expectedRevision) return
    const sprint = available.find(item => String(item.id) === selected) ??
      available.find(item => item.state === 'active') ?? available[0]
    if (!sprint) {
      sprints = available
      selected = ''
      cache = []
      retryAt = 0
      render()
      applyStatus('На доске нет активных или будущих спринтов.')
      await chrome.storage.local.remove('lastRead').catch(console.error)
      return
    }
    const id = String(sprint.id)
    const issues = await jira.issues(config.boardId, sprint, config.sprintField, config.cloud)
    if (revision !== expectedRevision) return
    const at = Date.now()
    retryAt = 0
    cache = [{id, sprint, issues, at}, ...cache.filter(item => item.id !== id &&
      available.some(option => String(option.id) === item.id))].slice(0, MAX_CACHE)
    selected = id
    sprints = available
    render()
    applyStatus('Актуально на ' + formatTime.format(at))
    try {
      await chrome.storage.local.set({lastRead: {base: config.base, boardId: config.boardId,
        cache, sprints, selected}})
    } catch {
      if (revision === expectedRevision) {
        applyStatus('Актуально на ' + formatTime.format(at) + ' · локальный кеш не сохранён.')
      }
    }
  } catch (error) {
    if (revision !== expectedRevision) return
    if (error.status === 429) {
      retryAt = Date.now() + Math.max(error.retryAfter, POLL_MS)
      queued = false
    }
    const record = snapshot()
    applyStatus((record ? 'Данные устарели · получены ' + formatTime.format(record.at) + '. ' :
      'Данные недоступны. ') + error.message, true)
  }
}

function installListeners() {
  function settingsDialog() {
    if (!ready) return
    openSettings(settings, windowId, async updated => {
      const boardChanged = settings.boardId !== updated.boardId || settings.base !== updated.base
      saving = true
      queued = false
      revision++
      try {
        await chrome.storage.local.set(boardChanged
          ? {settings: updated, lastRead: null} : {settings: updated})
      } catch (error) {
        saving = false
        requestRefresh()
        throw error
      }
      saving = false
      settings = updated
      if (boardChanged) {
        cache = []
        sprints = []
        selected = ''
        sourceTabId = undefined
        retryAt = 0
      }
      render()
      showUpdating()
      requestRefresh()
    })
  }
  $('settings').addEventListener('click', settingsDialog)
  $('configure').addEventListener('click', settingsDialog)
  $('refresh').addEventListener('click', () => {
    if (Date.now() >= retryAt) showUpdating()
    requestRefresh()
  })
  $('sprint').addEventListener('change', () => {
    selected = $('sprint').value
    revision++
    render()
    showUpdating()
    requestRefresh()
  })
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'jira-written' || sender.tab?.id !== sourceTabId ||
        !withinBase(sender.url, settings.base)) return
    clearTimeout(signalTimer)
    signalTimer = setTimeout(requestRefresh, SAVE_DELAY_MS)
  })
  chrome.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.status === 'complete' && tab.windowId === windowId &&
        (id === sourceTabId || tab.active) && withinBase(tab.url, settings.base)) requestRefresh()
  })
  chrome.tabs.onActivated.addListener(({windowId: id}) => {
    if (id === windowId) requestRefresh()
  })
}

async function init() {
  const [window, persisted] = await Promise.all([
    chrome.windows.getCurrent(),
    chrome.storage.local.get(['settings', 'lastRead'])
  ])
  windowId = window.id
  settings = persisted.settings ?? settings
  const last = persisted.lastRead
  if (last?.base === settings.base && last.boardId === settings.boardId) {
    cache = last.cache
    sprints = last.sprints
    selected = last.selected
  }
  ready = true
  installListeners()
  render()
  if (settings.boardId) {
    showUpdating()
    requestRefresh()
  }
}

init().catch(error => {
  $('dashboard').hidden = false
  applyStatus('Не удалось открыть панель. ' + error.message, true)
})
