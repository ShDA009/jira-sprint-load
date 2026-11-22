import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'

const base = 'https://jira.test'
const standalone = process.argv.includes('--standalone')
const temp = await mkdtemp(join(tmpdir(), 'jira-browser-'))
const extension = join(temp, 'extension')
const profile = join(temp, 'profile')
const requests = []
let unavailable = false
let assignee = 'anna'
let estimate = 4
let done = false
let moved = false
let transitionPage
const users = [
  {accountId: 'anna', displayName: 'Анна'},
  {accountId: 'max', displayName: 'Максим'}
]
const boardPath = '/rest/agile/1.0/board/17'
const issuePath = '/rest/software/1.0/board/17/sprint/'
const sprints = [
  {id: 1, state: 'active', name: 'Pilot A', startDate: '2025-01-01T09:00:00Z', endDate: '2025-01-07T17:00:00Z'},
  {id: 2, state: 'future', name: 'Pilot B', startDate: '2026-12-07T09:00:00Z', endDate: '2026-12-11T17:00:00Z'}
]

const issue = (id, account, remaining, extra = {}) => ({
  id, key: 'FIX-' + id, fields: {
    summary: 'Задача ' + id, assignee: users.find(user => user.accountId === account) ?? null,
    timeoriginalestimate: remaining === null ? null : 6 * 3600,
    timeestimate: remaining === null ? null : remaining * 3600,
    status: {statusCategory: {key: 'indeterminate'}}, issuetype: {subtask: false}, subtasks: [],
    customfield_7: [{id: 1, state: 'active'}], ...extra
  }
})

function response(url, method, postData, headers) {
  if (url.pathname === '/jira/software/boards/17') {
    return {value: '<title>Jira fixture</title>', html: true}
  }
  if (url.pathname === '/favicon.ico') return {status: 204}
  requests.push({url: url.href, method})
  if (unavailable) return {status: 503}
  if (url.pathname === '/rest/api/2/issue/FIX-1' && method === 'PUT') {
    const update = JSON.parse(postData)
    assignee = update.assignee ?? assignee
    estimate = update.estimate ?? estimate
    done = update.done ?? done
    moved = update.moved ?? moved
    return {status: 204}
  }
  assert.match(headers.Cookie ?? headers.cookie ?? '', /jira_session=fixture/)
  const startAt = Number(url.searchParams.get('startAt') ?? 0)
  const list = (key, values) => ({value: {[key]: values.slice(startAt, startAt + 1), total: values.length}})
  const issueList = values => {
    const offset = Number(url.searchParams.get('nextPageToken') ?? 0)
    const isLast = offset + 1 >= values.length
    return {value: {issues: values.slice(offset, offset + 1), isLast,
      nextPageToken: isLast ? undefined : String(offset + 1)}}
  }
  switch (url.pathname) {
    case '/rest/api/2/serverInfo': return {value: {deploymentType: 'Cloud', version: 'test'}}
    case '/rest/api/2/myself': return {value: users[0]}
    case '/rest/api/2/field': return {value: [{id: 'customfield_7',
      schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint'}}]}
    case '/rest/agile/1.0/board': return list('values', [{id: 17, name: 'Pilot Board'}])
    case boardPath: return {value: {id: 17, name: 'Pilot Board'}}
    case boardPath + '/sprint': return list('values', sprints)
    case issuePath + '1/issue': return issueList([
      ...(moved ? [] : [issue('1', assignee, estimate, done
        ? {status: {statusCategory: {key: 'done'}}} : {})]),
      issue('2', 'anna', null), issue('3', null, 2),
      issue('4', 'max', 100, {status: {statusCategory: {key: 'done'}}})
    ])
    case issuePath + '2/issue': return issueList([
      issue('5', 'max', 1, {customfield_7: [{id: 2, state: 'future'}]}),
      ...(moved ? [issue('1', assignee, estimate, {customfield_7: [{id: 2, state: 'future'}]})] : [])
    ])
    case '/rest/api/2/user/search': return {value: users}
    default: throw new Error('Неожиданный запрос: ' + url)
  }
}

function chromeStub() {
  const listeners = new Set()
  const isolated = {addEventListener(...args) {
    document.querySelector('iframe').contentWindow.addEventListener(...args)
  }}
  const tab = {id: 17, active: true, url: location.origin + '/jira/software/boards/17'}
  const ignoreEvent = {addListener() {}}
  Object.assign(chrome, {
    storage: {local: {
      async get(keys) {
        return Object.fromEntries(keys.map(key => [key, JSON.parse(localStorage.getItem(key))]))
      },
      async set(entries) {
        for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, JSON.stringify(value))
      },
      async remove(key) { localStorage.removeItem(key) }
    }},
    windows: {async getCurrent() { return {id: 1} }},
    tabs: {async query() { return [tab] }, onUpdated: ignoreEvent, onActivated: ignoreEvent},
    permissions: {async request() { return true }, async remove() { return true }},
    runtime: {onMessage: {addListener(listener) { listeners.add(listener) }}},
    scripting: {async executeScript({func, args, world}) {
      const jira = document.querySelector('iframe').contentWindow
      jira.chrome.runtime ??= {async sendMessage(message) {
        for (const listener of listeners) listener(message, {tab, url: tab.url})
      }}
      const script = jira.eval('(window) => (' + func.toString() + ')')(world === 'MAIN' ? jira : isolated)
      return [{result: await script(...args)}]
    }}
  })
}

async function panelFile(pathname) {
  const name = pathname.slice('/_panel/'.length)
  const original = await readFile(join(extension, name))
  if (name.endsWith('.html')) {
    return {type: 'text/html', body: original.toString()
      .replace('<head>', '<head><script>(' + chromeStub.toString() + ')()</script>')
      .replace('<body>', '<body><iframe hidden src="/jira/software/boards/17"></iframe>')}
  }
  const type = name.endsWith('.css') ? 'text/css' : 'application/javascript'
  return {type, body: original}
}

async function until(check, description, ms = 6000) {
  const end = Date.now() + ms
  do {
    const value = await check()
    if (value) return value
    await pause(70)
  } while (Date.now() < end)
  throw new Error('Не дождались: ' + description)
}

function startChrome() {
  const args = [
    '--headless', '--no-sandbox', '--no-zygote', '--single-process', '--disable-gpu',
    '--disable-dev-shm-usage', '--disable-crashpad-for-testing', '--disable-background-networking',
    '--disable-default-apps', '--no-first-run', '--disable-sync', '--no-proxy-server',
    '--user-data-dir=' + profile, '--remote-debugging-pipe',
    ...(standalone ? [] : ['--enable-unsafe-extension-debugging']), 'about:blank'
  ]
  const child = spawn(process.env.CHROMIUM ?? 'chromium', args,
    {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']})
  const pending = new Map()
  let sequence = 0
  let buffer = ''
  let error
  let stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000) })
  const close = once(child, 'exit')
  close.then(() => {
    for (const {reject} of pending.values()) reject(new Error(stderr || 'Chromium завершился'))
  }).catch(() => {})
  child.stdio[3].on('error', () => {})
  child.stdio[4].on('error', () => {})
  function call(method, params = {}, sessionId) {
    if (error) return Promise.reject(error)
    const id = ++sequence
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject})
      child.stdio[3].write(JSON.stringify({id, method, params, sessionId}) + '\0')
    })
  }

  async function handle({params, sessionId}) {
    const {requestId, request} = params
    const url = new URL(request.url)
    if (url.origin !== base) {
      error = new Error('Запрос на сторонний домен: ' + url)
      return
    }
    const staticFile = url.pathname.startsWith('/_panel/') ? await panelFile(url.pathname) : null
    let result = staticFile ?? response(url, request.method, request.postData, request.headers)
    if (transitionPage && url.pathname === issuePath + '2/issue' &&
        url.searchParams.get('nextPageToken') === '1') {
      if (await transitionPage) result = {status: 503}
    }
    const body = staticFile ? staticFile.body : result.html ? result.value : JSON.stringify(result.value ?? {})
    const responseHeaders = [
      {name: 'Content-Type', value: staticFile?.type ?? (result.html ? 'text/html; charset=utf-8' : 'application/json')}
    ]
    if (result.html) responseHeaders.push({name: 'Set-Cookie',
      value: 'jira_session=fixture; Path=/; Secure; HttpOnly; SameSite=Strict'})
    await call('Fetch.fulfillRequest', {requestId, responseCode: result.status ?? 200, responseHeaders,
      body: result.status === 204 ? undefined : Buffer.from(body).toString('base64')}, sessionId)
  }

  child.stdio[4].on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\0')
    buffer = lines.pop()
    for (const line of lines) {
      const message = JSON.parse(line)
      if (message.id) {
        const callbacks = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) callbacks?.reject(new Error(message.error.message))
        else callbacks?.resolve(message.result)
      }
      if (message.method === 'Fetch.requestPaused') {
        handle(message).catch(failure => { error = failure })
      }
    }
  })

  async function tab(url, mock = false) {
    const {targetId} = await call('Target.createTarget', {url: 'about:blank'})
    const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true})
    const send = (method, params) => call(method, params, sessionId)
    if (mock) await send('Fetch.enable', {patterns: [{urlPattern: 'http*'}]})
    await send('Page.navigate', {url})
    return {
      async eval(expression) {
        const {result, exceptionDetails} = await send('Runtime.evaluate',
          {expression, returnByValue: true, awaitPromise: true, userGesture: true})
        if (exceptionDetails) throw new Error(result.description ?? exceptionDetails.text)
        return result.value
      }
    }
  }

  return {
    call, tab,
    async stop() {
      try { await call('Browser.close') } catch { child.kill() }
      await close
    }
  }
}

const hasText = (panel, selector, text) => panel.eval(
  `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`)
const click = (panel, selector) => panel.eval(`document.querySelector(${JSON.stringify(selector)}).click()`)
const input = (panel, selector, value, event = 'input') => panel.eval(`(() => {
  const field = document.querySelector(${JSON.stringify(selector)})
  field.value = ${JSON.stringify(value)}
  field.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles: true}))
})()`)

async function open(browser, previousId) {
  if (standalone) {
    const panel = await browser.tab(base + '/_panel/panel.html', true)
    const jira = {eval: expression => panel.eval(
      'document.querySelector("iframe").contentWindow.eval(' + JSON.stringify(expression) + ')')}
    await until(() => jira.eval('document.title === "Jira fixture"'), 'Jira frame')
    return {jira, panel}
  }
  const jira = await browser.tab(base + '/jira/software/boards/17', true)
  await until(() => jira.eval('document.title === "Jira fixture"'), 'Jira tab')
  const id = previousId ?? (await browser.call('Extensions.loadUnpacked', {path: extension})).id
  const panel = await browser.tab('chrome-extension://' + id + '/panel.html')
  await until(() => panel.eval('!!document.querySelector("#settings")'), 'extension page')
  return {jira, panel, id}
}

let browser
try {
  await cp(new URL('../jira-sprint-load/', import.meta.url), extension, {recursive: true})
  const path = join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(manifest.host_permissions, undefined)
  // Grant the mock host in this test copy so Chrome does not show a native permission prompt.
  manifest.host_permissions = [base + '/*']
  await writeFile(path, JSON.stringify(manifest))

  browser = startChrome()
  let {jira, panel, id} = await open(browser)
  await until(() => panel.eval('!document.querySelector("#empty").hidden'), 'initial setup')
  await click(panel, '#configure')
  await input(panel, '#jira-base', base)
  await click(panel, '#connect')
  await until(() => hasText(panel, '#connection', 'Cloud · test'), 'REST and Jira session')
  await input(panel, '#boards', 17, 'change')
  await click(panel, '#sample')
  await until(() => hasText(panel, '#sample-result', 'Remaining Estimate: 2'), 'field diagnostics')
  await input(panel, '#subtasks', 'parents')
  await input(panel, '#zone', 'UTC')
  await input(panel, '#user-query', 'Анна')
  await click(panel, '#find-user')
  await until(() => hasText(panel, '#user-results', 'Максим'), 'user search')
  await click(panel, '#user-results button:first-child')
  await click(panel, '#user-results button:first-child')
  const exportedTeam = await panel.eval(`(async () => {
    const originalClick = HTMLAnchorElement.prototype.click
    let download
    HTMLAnchorElement.prototype.click = function () {
      download = {name: this.download, json: fetch(this.href).then(response => response.json())}
    }
    try {
      document.querySelector('#team-export').click()
      return {name: download.name, file: await download.json}
    } finally {
      HTMLAnchorElement.prototype.click = originalClick
    }
  })()`)
  assert.equal(exportedTeam.name, 'jira-team.json')
  assert.equal(exportedTeam.file.jira, base)
  assert.deepEqual(exportedTeam.file.team.map(member => member.id), ['anna', 'max'])
  const importFile = contents => panel.eval(`(() => {
    const input = document.querySelector('#team-file')
    const files = new DataTransfer()
    files.items.add(new File([${JSON.stringify(contents)}], 'team.json', {type: 'application/json'}))
    input.files = files.files
    input.dispatchEvent(new Event('change'))
  })()`)
  await importFile('{broken')
  await until(() => hasText(panel, '#team-transfer-status', 'Не удалось прочитать JSON'), 'invalid import')
  const changed = structuredClone(exportedTeam.file)
  changed.team = changed.team.filter(member => member.id === 'max')
  await importFile(JSON.stringify(changed))
  await until(() => hasText(panel, '#team-transfer-status', 'В файле участников: 1'), 'import preview')
  assert.equal(await panel.eval('document.querySelectorAll("#team-edit .team-card").length'), 2)
  await click(panel, '#team-import-apply')
  assert.equal(await panel.eval('document.querySelectorAll("#team-edit .team-card").length'), 1)
  await importFile(JSON.stringify(exportedTeam.file))
  await until(() => hasText(panel, '#team-transfer-status', 'В файле участников: 2'), 'round-trip preview')
  await click(panel, '#team-import-apply')
  await click(panel, '#save')
  await until(() => hasText(panel, '#status', 'Актуально'), 'first load')
  await until(() => jira.eval('window[Symbol.for("jira-sprint-capacity:updated")]'), 'Jira save observer')
  assert.ok(await hasText(panel, '[data-id="anna"]', 'Перегруз 4 ч'))
  assert.ok(await hasText(panel, '[data-id="anna"]', 'Оценены не все задачи'))
  assert.ok(await hasText(panel, '[data-id="max"]', 'Незавершённых: 0'))
  assert.equal(await panel.eval('!!document.querySelector("[data-id=anna] meter")'), false)
  assert.ok(await hasText(panel, '[data-id="unassigned"]', '· 1'))
  assert.equal(await panel.eval('document.querySelector("[data-id=anna] a").href'), base + '/browse/FIX-1')

  const start = Date.now()
  await jira.eval(`fetch('/rest/api/2/issue/FIX-1', {method: 'PUT',
    body: JSON.stringify({assignee: 'max', estimate: 5})}).then(response => response.status)`)
  await until(() => hasText(panel, '[data-id="max"]', 'Перегруз 5 ч'), 'local save', 5000)
  console.log('Local save updated in ' + (Date.now() - start) + ' ms')
  assert.ok(await hasText(panel, '[data-id="anna"]', 'Незавершённых: 1'))

  async function saveWithXhr(fields) {
    await jira.eval(`new Promise(resolve => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', '/rest/api/2/issue/FIX-1')
      xhr.onloadend = resolve
      xhr.send(${JSON.stringify(JSON.stringify(fields))})
    })`)
  }
  await saveWithXhr({done: true})
  await until(() => hasText(panel, '[data-id="max"]', 'Незавершённых: 0'), 'local status change')
  const activeReads = () => requests.filter(item => new URL(item.url).pathname === issuePath + '1/issue').length
  const beforeMove = activeReads()
  await saveWithXhr({done: false, moved: true})
  await until(() => activeReads() >= beforeMove + 3, 'local sprint change')
  await input(panel, '#sprint', 2, 'change')
  await until(() => hasText(panel, '[data-id="max"]', '12 ч / 24 ч'), 'issue moved into future sprint')
  await saveWithXhr({moved: false})
  await until(() => hasText(panel, '[data-id="max"]', '6 ч / 24 ч'), 'issue moved back')
  await input(panel, '#sprint', 1, 'change')
  await until(async () => await hasText(panel, '#status', 'Актуально') &&
    await hasText(panel, '[data-id="max"]', 'Перегруз 5 ч'), 'back to active sprint')

  const remote = Date.now()
  estimate = 7
  await until(() => hasText(panel, '[data-id="max"]', 'Перегруз 7 ч'), 'external change', 20_000)
  console.log('External change updated in ' + (Date.now() - remote) + ' ms')

  unavailable = true
  await click(panel, '#refresh')
  await until(() => hasText(panel, '#status', 'Данные устарели · получены'), 'stale cache')
  assert.ok(await hasText(panel, '[data-id="max"]', 'Перегруз 7 ч'))
  unavailable = false
  await until(() => hasText(panel, '#status', 'Актуально'), 'automatic recovery', 20_000)

  await input(panel, '#sprint', 2, 'change')
  await until(() => hasText(panel, '[data-id="max"]', '6 ч / 24 ч'), 'future Original Estimate')
  await click(panel, '#settings')
  assert.equal(await panel.eval('document.querySelectorAll("#editor input[type=date]").length'), 0)
  await panel.eval('document.querySelectorAll(".team-card").forEach(card => { card.open = true })')
  assert.equal(await panel.eval(`document.querySelectorAll('.team-card input[placeholder="По графику"]').length`), 0)
  await input(panel, '[data-id="max"].team-card input[type="number"]', '0')
  await click(panel, '#save')
  await until(() => hasText(panel, '[data-id="max"]', 'Перегруз 6 ч'), 'zero participation')
  await until(() => hasText(panel, '#status', 'Актуально'), 'saved team availability')
  await panel.eval(`(async () => {
    const {settings} = await chrome.storage.local.get(['settings'])
    settings.team.find(member => member.id === 'anna').overrides = {2: {kind: 'total', hours: 10}}
    settings.team.find(member => member.id === 'max').overrides = {2: 50}
    await chrome.storage.local.set({settings})
  })()`)

  await browser.stop()
  browser = startChrome()
  ;({panel} = await open(browser, id))
  await until(() => hasText(panel, '#status', 'Актуально'), 'browser restart')
  assert.ok(await hasText(panel, '#board-name', 'Pilot Board'))
  assert.ok(await hasText(panel, '[data-id="max"]', 'Перегруз 6 ч'))
  assert.ok(await hasText(panel, '[data-id="anna"]', 'Задач: 0'))

  await panel.eval('Date.now = () => Date.parse("2026-12-07T13:00:00Z")')
  sprints[1].state = 'active'
  moved = true
  const transitionReads = () => requests.filter(({url}) => {
    const page = new URL(url)
    return page.pathname === issuePath + '2/issue' && page.searchParams.get('nextPageToken') === '1'
  }).length
  async function holdTransitionPage() {
    const before = transitionReads()
    const {promise, resolve} = Promise.withResolvers()
    transitionPage = promise
    await click(panel, '#refresh')
    await until(() => transitionReads() > before, 'last issue page of started sprint')
    return failed => {
      transitionPage = undefined
      resolve(failed)
    }
  }
  function checkFutureSnapshot() {
    return Promise.all([
      hasText(panel, '#sprint option:checked', 'будущий'),
      hasText(panel, '#hours-heading', 'Назначено'),
      hasText(panel, '[data-id="max"]', '6 ч / 0 ч'),
      hasText(panel, '[data-id="anna"]', '0 ч / 24 ч')
    ]).then(values => assert.ok(values.every(Boolean), values.join(', ')))
  }
  const failPage = await holdTransitionPage()
  await checkFutureSnapshot()
  failPage(true)
  await until(() => hasText(panel, '#status', 'Данные устарели · получены'), 'failed transition')
  await checkFutureSnapshot()

  const publishPage = await holdTransitionPage()
  await checkFutureSnapshot()
  publishPage(false)
  await until(() => hasText(panel, '#status', 'Актуально'), 'successful transition')
  assert.ok(await hasText(panel, '#sprint option:checked', 'активный'))
  assert.ok(await hasText(panel, '#hours-heading', 'Осталось работы'))
  assert.ok(await hasText(panel, '[data-id="max"]', '8 ч / 0 ч'))
  assert.ok(await hasText(panel, '[data-id="anna"]', '0 ч / 21,6 ч'))

  await panel.eval('Date.now = () => Date.parse("2026-12-11T16:00:00Z")')
  unavailable = true
  await input(panel, '#sprint', 1, 'change')
  await until(() => hasText(panel, '#status', 'Данные устарели · получены'), 'offline sprint switch')
  await input(panel, '#sprint', 2, 'change')
  await until(() => hasText(panel, '#status', 'Данные устарели · получены'), 'cached active sprint')
  assert.ok(await hasText(panel, '[data-id="anna"]', '0 ч / 21,6 ч'))

  unavailable = false
  const endDate = sprints[1].endDate
  sprints[1].endDate = null
  await click(panel, '#refresh')
  await until(() => hasText(panel, '#notice', 'В Jira нет корректных дат спринта'), 'missing Jira dates')
  assert.ok(await hasText(panel, '[data-id="max"]', 'Ёмкость не определена'))
  sprints[1].endDate = endDate
  await click(panel, '#refresh')
  await until(() => hasText(panel, '[data-id="anna"]', '0 ч / 0,6 ч'), 'Jira dates restored')

  assert.equal(requests.filter(item => item.method !== 'GET').length, 4)
  assert.ok(requests.every(item => new URL(item.url).origin === base))
  console.log(standalone ? 'Chromium UI checks with Chrome API stubs passed' : 'Chromium extension checks passed')
} finally {
  try { await browser?.stop() } finally { await rm(temp, {recursive: true, force: true}) }
}
