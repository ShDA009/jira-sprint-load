import {normalizeIssue, withinBase} from './model.mjs'

const CHANGE_EVENT = 'jira-sprint-capacity:updated'

export function permissionFor(base) {
  const url = new URL(base)
  return url.protocol + '//' + url.hostname + '/*'
}

// Executed in Jira's isolated world so the request uses the current Jira session.
async function jiraGet(base, path) {
  const jira = new URL(base)
  const context = jira.pathname.replace(/\/$/, '')
  if (location.origin !== jira.origin ||
      (location.pathname !== context && !location.pathname.startsWith(context + '/'))) {
    return {error: 'Откройте вкладку настроенной Jira.'}
  }
  try {
    const response = await fetch(base + path, {
      credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(12_000)
    })
    if (!response.ok) {
      return {status: response.status, retryAfter: response.headers.get('Retry-After')}
    }
    if (!response.headers.get('Content-Type')?.toLowerCase().includes('json')) {
      return {error: 'Jira вернула страницу вместо JSON. Проверьте вход в Jira и адрес.'}
    }
    return {value: await response.json()}
  } catch {
    return {error: 'Не удалось прочитать Jira. Проверьте соединение и вход в Jira.'}
  }
}

// Executed in Jira's main world. Emits only a signal after a successful write.
function observeWrites(base, eventName) {
  const jira = new URL(base)
  const context = jira.pathname.replace(/\/$/, '')
  if (location.origin !== jira.origin ||
      (location.pathname !== context && !location.pathname.startsWith(context + '/'))) return
  const marker = Symbol.for(eventName)
  if (window[marker]) return
  window[marker] = true

  function shouldNotify(value, method) {
    if (!['PATCH', 'POST', 'PUT', 'DELETE'].includes(String(method).toUpperCase())) return false
    try {
      const url = new URL(value, location.href)
      if (url.origin !== jira.origin || !url.pathname.startsWith(context + '/')) return false
      const path = url.pathname.slice(context.length)
      return /^\/(?:gateway\/api\/)?rest\//i.test(path) ||
        /^\/gateway\/api\/(?:jsw|jira|graphql)(?:\/|$)/i.test(path) ||
        /^\/secure\/(?:.*Issue|.*Sprint).*\.jspa$/i.test(path)
    } catch {
      return false
    }
  }

  function notify() {
    window.dispatchEvent(new Event(eventName))
  }

  const originalFetch = window.fetch
  window.fetch = function(input, init) {
    const result = originalFetch.apply(this, arguments)
    const url = input instanceof Request ? input.url : input
    if (shouldNotify(url, init?.method ?? (input instanceof Request ? input.method : 'GET'))) {
      result.then(response => { if (response.ok) notify() }, () => {})
    }
    return result
  }

  const writes = new WeakMap()
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function(method, url) {
    const result = originalOpen.apply(this, arguments)
    writes.set(this, shouldNotify(url, method))
    return result
  }
  XMLHttpRequest.prototype.send = function() {
    if (writes.get(this)) {
      this.addEventListener('loadend', () => {
        if (this.status >= 200 && this.status < 300) notify()
      }, {once: true})
    }
    return originalSend.apply(this, arguments)
  }
}

function relayChanges(eventName) {
  const marker = Symbol.for(eventName)
  if (window[marker]) return
  window[marker] = true
  window.addEventListener(eventName, () => {
    chrome.runtime.sendMessage({type: 'jira-written'}).catch(() => {})
  })
}

export async function jiraTab(base, windowId, preferredTabId) {
  const tabs = await chrome.tabs.query({windowId})
  const matching = tabs.filter(tab => withinBase(tab.url, base))
  const tab = matching.find(item => item.active) ??
    matching.find(item => item.id === preferredTabId) ??
    (matching.length === 1 ? matching[0] : null)
  if (!tab) throw new Error('Откройте вкладку настроенной Jira в этом окне Chrome.')
  return tab
}

export async function observe(tabId, base) {
  const target = {tabId}
  await chrome.scripting.executeScript({target, func: relayChanges, args: [CHANGE_EVENT]})
  await chrome.scripting.executeScript({
    target, world: 'MAIN', func: observeWrites, args: [base, CHANGE_EVENT]
  })
}

export class Jira {
  constructor(base, tabId) {
    this.base = base
    this.tabId = tabId
  }

  async get(path, query = {}) {
    const search = new URLSearchParams(query).toString()
    const [script] = await chrome.scripting.executeScript({
      target: {tabId: this.tabId}, func: jiraGet,
      args: [this.base, path + (search ? '?' + search : '')]
    })
    const result = script?.result
    if (!result) throw new Error('Вкладка Jira недоступна.')
    if (result.error) throw new Error(result.error)
    if (result.status) {
      const error = new Error({
        401: 'Войдите в Jira в открытой вкладке.',
        403: 'Jira отказала в доступе. Проверьте права на доску и REST API.',
        404: 'Ресурс REST API Jira не найден. Проверьте адрес, версию и права на доску.',
        429: 'Jira ограничила частоту запросов. Повторим после паузы.'
      }[result.status] ?? 'Jira вернула ошибку HTTP ' + result.status + '.')
      error.status = result.status
      const delay = Number(result.retryAfter)
      const date = Date.parse(result.retryAfter)
      error.retryAfter = Number.isFinite(delay) ? delay * 1000 :
        Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
      throw error
    }
    return result.value
  }

  async pages(path, key, query = {}, tokenBased = false) {
    const first = await this.readPages(path, key, query, tokenBased)
    if (first) return first
    if (!tokenBased) {
      const retry = await this.readPages(path, key, query, tokenBased)
      if (retry) return retry
    }
    throw new Error('Jira не вернула все страницы. Итог предыдущего обновления сохранён.')
  }

  async readPages(path, key, query, tokenBased) {
    const items = new Map()
    let startAt = 0
    let total
    let nextPageToken
    const tokens = new Set()
    for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
      const pagination = tokenBased ? (nextPageToken ? {nextPageToken} : {}) : {startAt}
      const page = await this.get(path, {...query, ...pagination, maxResults: 50})
      const values = page?.[key]
      if (!Array.isArray(values)) throw new Error('Jira вернула неожиданный формат списка.')
      if (!tokenBased) {
        if (page.startAt != null && page.startAt !== startAt) break
        if (Number.isFinite(page.total)) {
          if (total !== undefined && page.total !== total) break
          total = page.total
        }
      }
      for (const value of values) {
        const id = value.id ?? value.key
        if (id == null) throw new Error('Jira вернула запись без идентификатора.')
        items.set(String(id), value)
      }
      if (tokenBased) {
        if (!page.nextPageToken && page.isLast !== false) return [...items.values()]
        if (!page.nextPageToken || tokens.has(page.nextPageToken)) break
        nextPageToken = page.nextPageToken
        tokens.add(nextPageToken)
        continue
      }
      startAt += values.length
      if (items.size !== startAt || (total !== undefined && startAt > total)) break
      if (page.isLast || startAt === total || (!values.length && total === undefined)) {
        if (total === undefined || items.size === total) return [...items.values()]
        break
      }
      if (!values.length) break
    }
    return null
  }

  async inspect() {
    const [server, fields, boards] = await Promise.all([
      this.get('/rest/api/2/serverInfo'),
      this.get('/rest/api/2/field'),
      this.pages('/rest/agile/1.0/board', 'values', {type: 'scrum'}),
      this.get('/rest/api/2/myself')
    ])
    if (!Array.isArray(fields) || !server?.deploymentType) {
      throw new Error('Не удалось определить версию Jira и список полей.')
    }
    return {
      server: [server.deploymentType, server.version].filter(Boolean).join(' · '),
      cloud: String(server.deploymentType).toLowerCase() === 'cloud',
      sprintField: fields.find(field => field.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id,
      boards
    }
  }

  sprints(boardId) {
    return this.pages('/rest/agile/1.0/board/' + boardId + '/sprint', 'values', {
      state: 'active,future'
    })
  }

  async verifyAccess(boardId) {
    const [user, board] = await Promise.all([
      this.get('/rest/api/2/myself'),
      this.get('/rest/agile/1.0/board/' + boardId)
    ])
    if (!(user?.accountId || user?.key || user?.name) || String(board?.id) !== String(boardId)) {
      throw new Error('Jira не подтвердила доступ к выбранной доске.')
    }
  }

  async issues(boardId, sprint, sprintField, cloud) {
    const fields = ['summary', 'assignee', 'status', 'issuetype', 'subtasks',
      'timeoriginalestimate', 'timeestimate', 'timetracking', 'closedSprints', sprintField]
    const issues = await this.pages(
      (cloud ? '/rest/software' : '/rest/agile') + '/1.0/board/' + boardId + '/sprint/' + sprint.id + '/issue',
      'issues', {fields: fields.filter(Boolean).join(',')}, cloud
    )
    return issues.map(issue => normalizeIssue(issue, sprint.id, sprintField))
  }

  async users(query, isCloud) {
    const values = await this.get('/rest/api/2/user/search', {
      [isCloud ? 'query' : 'username']: query, maxResults: 12
    })
    if (!Array.isArray(values)) throw new Error('Jira вернула неожиданный формат списка участников.')
    return values.filter(user => user.active !== false).map(user => ({
      id: user.accountId || user.key || user.name, name: user.displayName || user.name
    })).filter(user => user.id && user.name)
  }
}
