// Sensitive-content scanner.
//
// Two rules govern everything here:
//
// 1. A finding NEVER carries the full matched text. The report gets shown, pasted into
//    issues, and committed to CI logs — a scanner whose output leaks the secret it found
//    is worse than no scanner. Every finding carries a masked excerpt and a length.
//
// 2. Over-flagging is a failure, not a safe default. A check people learn to ignore
//    stops being a check. Placeholders that documentation genuinely needs
//    (example.com, 127.0.0.1, 0.0.0.0) are excluded by construction, not by luck.

export const CRITICAL = 'critical'
export const HIGH = 'high'
export const MEDIUM = 'medium'
export const LOW = 'low'

export const SEVERITY_ORDER = [CRITICAL, HIGH, MEDIUM, LOW]

/** Severities that block a pack unless the operator explicitly overrides. */
export const BLOCKING = new Set([CRITICAL, HIGH])

// Hosts and literals that appear in documentation on purpose. Matching them is noise.
const PLACEHOLDER_HOSTS = /^(example|test|localhost|invalid|acme|foo|bar|domain|yourdomain|company)\b|\.(example|test|invalid|localhost)$|^example\.(com|org|net)$/i
const PLACEHOLDER_IPS = new Set(['0.0.0.0', '127.0.0.1', '255.255.255.255', '::1'])

// Values that are obviously stand-ins rather than real secrets. Deliberately written as an
// exact-match list on the extracted value: an earlier version tested the whole match with an
// alternation containing `\s*`, which matches the empty string, so every value looked like a
// placeholder and the rule silently never fired.
const PLACEHOLDER_VALUE =
  /^(?:x+|\*+|\.+|changeme|change[_-]?me|your[_-]?[\w-]*|my[_-]?[\w-]*|<.+>|\$\{.+\}|%[\w-]+%|\{\{.+\}\}|process\.env\b.*|os\.environ\b.*|null|none|nil|true|false|undefined|example[\w-]*|placeholder|redacted|dummy|sample|test[\w-]*|todo|fixme|secret|password|passwd|token|api[_-]?key)$/i

function isPlaceholderValue(value) {
  const trimmed = value.trim()
  return trimmed === '' || PLACEHOLDER_VALUE.test(trimmed)
}

const RULES = [
  // --- credentials: leaking one of these is an incident ---------------------
  {
    id: 'anthropic-key',
    severity: CRITICAL,
    label: 'Anthropic API key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'openai-key',
    severity: CRITICAL,
    label: 'OpenAI API key',
    re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g,
  },
  {
    id: 'github-token',
    severity: CRITICAL,
    label: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  },
  {
    id: 'aws-access-key',
    severity: CRITICAL,
    label: 'AWS access key id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'google-api-key',
    severity: CRITICAL,
    label: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'slack-token',
    severity: CRITICAL,
    label: 'Slack token',
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
  },
  {
    id: 'private-key',
    severity: CRITICAL,
    label: 'private key block',
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
  {
    id: 'jwt',
    severity: CRITICAL,
    label: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'connection-string',
    severity: CRITICAL,
    label: 'connection string with password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s/]+@[^\s/]+/gi,
    // A literal placeholder password is still a bad habit, but it is not a leak.
    ignore: (m) => /:(password|pass|pwd|secret|changeme|xxx+|\*+|<[^>]+>|\$\{[^}]+\})@/i.test(m),
  },
  {
    id: 'generic-secret-assignment',
    severity: HIGH,
    label: 'hardcoded secret assignment',
    re: /\b(?:api[_-]?key|secret|passwd|password|token|access[_-]?key)\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/gi,
    ignore: (m) => isPlaceholderValue(/["'`]([^"'`]*)["'`]\s*$/.exec(m)?.[1] ?? ''),
  },

  // --- personal data --------------------------------------------------------
  {
    id: 'cn-id-card',
    severity: HIGH,
    label: 'Chinese national ID number',
    re: /(?<![0-9A-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g,
  },
  {
    id: 'cn-mobile',
    severity: HIGH,
    label: 'Chinese mobile number',
    re: /(?<![0-9])1[3-9]\d{9}(?![0-9])/g,
  },
  {
    id: 'email',
    severity: MEDIUM,
    label: 'email address',
    re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    ignore: (m) => PLACEHOLDER_HOSTS.test(m.split('@')[1] ?? ''),
  },

  // --- internal topology ----------------------------------------------------
  {
    id: 'private-ip',
    severity: MEDIUM,
    label: 'private network address',
    re: /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/g,
    ignore: (m) => PLACEHOLDER_IPS.has(m),
  },
  {
    id: 'internal-hostname',
    severity: MEDIUM,
    label: 'internal hostname',
    re: /\b[a-z0-9][a-z0-9-]{0,62}\.(?:local|internal|intranet|lan|corp|home|priv)\b/gi,
    ignore: (m) => PLACEHOLDER_HOSTS.test(m),
  },
]

/** Mask a match so the report can be shown and stored without leaking it. */
export function mask(value) {
  const text = String(value)
  if (text.length <= 8) return `${text.slice(0, 2)}${'*'.repeat(Math.max(text.length - 2, 1))}`
  return `${text.slice(0, 4)}…${text.slice(-2)} (${text.length} chars)`
}

/** Byte offset -> 1-indexed line and column. */
function locate(text, offset) {
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++
      lastBreak = i
    }
  }
  return { line, column: offset - lastBreak }
}

/**
 * Compile a user-supplied rule from sparepack.yaml.
 * Author-provided patterns are trusted for intent but not for syntax.
 */
export function compileCustomRule(rule, index) {
  const id = rule.id ?? `custom-${index + 1}`
  if (typeof rule.pattern !== 'string' || !rule.pattern) {
    throw new Error(`custom scan rule "${id}": "pattern" must be a non-empty string`)
  }
  const severity = rule.severity ?? HIGH
  if (!SEVERITY_ORDER.includes(severity)) {
    throw new Error(`custom scan rule "${id}": severity must be one of ${SEVERITY_ORDER.join(', ')}`)
  }
  let re
  try {
    re = new RegExp(rule.pattern, rule.flags ?? 'g')
  } catch (err) {
    throw new Error(`custom scan rule "${id}": invalid regex — ${err.message}`)
  }
  if (!re.global) re = new RegExp(re.source, `${re.flags}g`)
  return { id, severity, label: rule.label ?? `custom rule ${id}`, re }
}

/**
 * Scan text for sensitive content.
 * Returns findings sorted by severity then position. Never returns raw matched text.
 */
export function scanText(text, { path = '<text>', customRules = [] } = {}) {
  const findings = []
  const rules = [...RULES, ...customRules]

  for (const rule of rules) {
    // Each scan gets a fresh regex: a shared /g regex carries lastIndex between calls.
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`)
    let match
    while ((match = re.exec(text)) !== null) {
      if (match[0] === '') {
        re.lastIndex++
        continue
      }
      if (rule.ignore?.(match[0])) continue
      const { line, column } = locate(text, match.index)
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        label: rule.label,
        path,
        line,
        column,
        excerpt: mask(match[0]),
      })
    }
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.line - b.line ||
      a.column - b.column,
  )
}

/** True when any finding is severe enough to stop the pack. */
export function hasBlockingFindings(findings) {
  return findings.some((f) => BLOCKING.has(f.severity))
}

export function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]))
  for (const f of findings) counts[f.severity]++
  return counts
}

export const __rulesForTest = RULES
