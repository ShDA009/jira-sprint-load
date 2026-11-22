export const byId = id => document.getElementById(id)

export function el(tag, text, className) {
  const node = document.createElement(tag)
  if (text != null) node.textContent = text
  if (className) node.className = className
  return node
}

export function button(text, action) {
  const node = el('button', text, 'quiet')
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

const decimal = new Intl.NumberFormat('ru', {maximumFractionDigits: 2})
export const hours = value => decimal.format(value) + ' ч'

function taskList(group, base, showAssignee) {
  if (!group.items.length) return el('p', 'Нет задач', 'no-tasks')
  const list = el('ul', null, 'task-list')
  for (const task of group.items) {
    const item = el('li')
    const link = el('a', task.key + ' · ' + task.title)
    link.href = base + '/browse/' + encodeURIComponent(task.key)
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    const estimate = task.hours === null ? 'Нет данных об оценке' : hours(task.hours)
    const meta = showAssignee && task.assigneeName ? task.assigneeName + ' · ' + estimate : estimate
    item.append(link, el('span', meta, 'task-meta'))
    list.append(item)
  }
  return list
}

function memberSummary(summary, row, active) {
  const heading = el('div', null, 'row-heading')
  const stats = el('div', null, 'row-stats')
  const delta = row.capacity === null ? null : row.capacity - row.known
  const over = delta !== null && delta < -1e-9
  const compare = row.capacity === null ? hours(row.known) + ' / —' :
    hours(row.known) + ' / ' + hours(row.capacity)
  heading.append(el('strong', row.member.name), el('span', compare, over ? 'over' : ''))
  const balance = delta === null ? 'Ёмкость не определена' :
    over ? 'Перегруз ' + hours(-delta) :
    row.missing ? (delta > 1e-9 ? 'Запас до ' + hours(delta) + ' (предварительно)' : 'Предварительный запас 0 ч') :
    'Свободно ' + hours(Math.max(0, delta))
  stats.append(el('span', active ? 'Незавершённых: ' + row.items.length : 'Задач: ' + row.items.length),
    el('span', balance, over ? 'over' : ''))
  summary.replaceChildren(heading, stats)
  if (row.capacity > 0) {
    const meter = el('meter', null, over ? 'over-meter' : '')
    meter.max = row.capacity
    meter.value = Math.min(row.known, meter.max)
    meter.setAttribute('aria-label', compare)
    summary.append(meter)
  }
  if (row.missing) summary.append(el('span', 'Оценены не все задачи', 'incomplete'))
}

export function renderRows(container, rows, base, active) {
  const existing = new Map(Array.from(container.children, node => [node.dataset.id, node]))
  let previous = null
  for (const {id, row, label} of rows) {
    let node = existing.get(id)
    existing.delete(id)
    if (!node) {
      node = el('details', null, label ? 'exception' : 'load-row')
      node.dataset.id = id
      node.append(el('summary'))
    }
    if (node !== (previous ? previous.nextElementSibling : container.firstElementChild)) {
      container.insertBefore(node, previous ? previous.nextElementSibling : container.firstElementChild)
    }
    previous = node
    const summary = node.firstElementChild
    const summaryKey = JSON.stringify([label, active, row.member?.name, row.known,
      row.capacity, row.missing, row.items.length])
    if (summary.dataset.revision !== summaryKey) {
      summary.dataset.revision = summaryKey
      if (label) summary.textContent = label + ' · ' + row.items.length
      else memberSummary(summary, row, active)
    }
    const taskKey = JSON.stringify([base, row.items])
    if (node.dataset.tasks !== taskKey) {
      node.dataset.tasks = taskKey
      node.children[1]?.remove()
      node.append(taskList(row, base, Boolean(label)))
    }
  }
  for (const node of existing.values()) node.remove()
}
