// shlex.quote / shlex.split（POSIX モード）相当。

const SAFE = /^[A-Za-z0-9@%+=:,./-]+$/

export function shellQuote(s: string): string {
  if (s === '') return "''"
  if (SAFE.test(s)) return s
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

export function shellSplit(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let inToken = false
  let i = 0
  while (i < s.length) {
    const c = s.charAt(i)
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) throw new Error('No closing quotation')
      cur += s.slice(i + 1, end)
      inToken = true
      i = end + 1
    } else if (c === '"') {
      i++
      inToken = true
      for (;;) {
        if (i >= s.length) throw new Error('No closing quotation')
        const d = s.charAt(i)
        if (d === '"') {
          i++
          break
        }
        if (d === '\\' && '"\\$`\n'.includes(s.charAt(i + 1)) && i + 1 < s.length) {
          cur += s.charAt(i + 1)
          i += 2
        } else {
          cur += d
          i++
        }
      }
    } else if (c === '\\') {
      if (i + 1 >= s.length) throw new Error('No escaped character')
      cur += s.charAt(i + 1)
      inToken = true
      i += 2
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur)
      cur = ''
      inToken = false
      i++
    } else {
      cur += c
      inToken = true
      i++
    }
  }
  if (inToken) out.push(cur)
  return out
}
