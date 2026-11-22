const FORMAT = 'jira-sprint-load-team'
const VERSION = 1

function isNumberInRange(value, max) {
  return Number.isFinite(value) && value >= 0 && value <= max
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

function cleanTeam(team) {
  if (!Array.isArray(team)) throw new Error('В файле отсутствует список участников.')
  const ids = new Set()
  return team.map((member, index) => {
    const {id, name, week, share, absences} = member ?? {}
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim() ||
        !Array.isArray(week) || week.length !== 7 ||
        !week.every(value => isNumberInRange(value, 24)) || !isNumberInRange(share, 100) ||
        !Array.isArray(absences)) {
      throw new Error('Проверьте имя, идентификатор и рабочий график участника №' + (index + 1) + '.')
    }
    if (ids.has(id)) throw new Error('В списке повторяется идентификатор Jira «' + id + '».')
    ids.add(id)
    return {id, name, week: [...week], share, absences: absences.map(absence => {
      const {from, to, hours} = absence ?? {}
      if (!isDate(from) || !isDate(to) || from > to ||
          (hours !== null && !isNumberInRange(hours, 24))) {
        throw new Error(name + ' · проверьте даты и длительность отсутствия.')
      }
      return {from, to, hours}
    })}
  })
}

export function exportTeam(base, team) {
  return JSON.stringify({format: FORMAT, version: VERSION, jira: base, team: cleanTeam(team)}, null, 2) + '\n'
}

export function importTeam(contents, base) {
  let file
  try {
    file = JSON.parse(contents.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('Не удалось прочитать JSON. Выберите файл экспорта команды.')
  }
  if (file?.format !== FORMAT || file.version !== VERSION) {
    throw new Error('Формат файла команды не поддерживается.')
  }
  if (file.jira !== base) {
    throw new Error('Файл экспортирован из другой Jira. Выберите файл для текущего подключения.')
  }
  return cleanTeam(file.team)
}
