// src/path.ts
function join(...parts) {
  let out = "";
  for (const part of parts) {
    if (part.startsWith("/"))
      out = part;
    else if (out === "" || out.endsWith("/"))
      out += part;
    else
      out += `/${part}`;
  }
  return out;
}
function dirname(p) {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  if (head !== "" && head !== "/".repeat(head.length))
    return head.replace(/\/+$/, "");
  return head;
}
function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

// src/config-dir.ts
var CLAUDE_CONFIG_DIRS = [".claude", ".agents"];
async function pickConfigDir(names, base, exists) {
  for (const name of names)
    if (await exists(join(base, name)))
      return join(base, name);
  return join(base, names[0] ?? ".claude");
}
var configPaths = (io, base, ...rel) => io.configDirNames.map((name) => join(base, name, ...rel));

// src/glob.ts
function splitTopCommas(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") {
      depth++;
      cur += c;
    } else if (c === "}") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}
function expandBraces(s) {
  let depth = 0;
  let start = -1;
  for (let i = 0;i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "{") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const pre = s.slice(0, start);
        const inner = s.slice(start + 1, i);
        const post = s.slice(i + 1);
        const out = [];
        for (const part of splitTopCommas(inner))
          out.push(...expandBraces(pre + part + post));
        return out;
      }
    }
  }
  return [s];
}
var escapeRegex = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
function globToRegex(pat) {
  const n = pat.length;
  let i = 0;
  let out = "^";
  while (i < n) {
    const c = pat.charAt(i);
    if (c === "*") {
      let j = i;
      while (j < n && pat.charAt(j) === "*")
        j++;
      if (j - i >= 2) {
        if (j < n && pat.charAt(j) === "/") {
          out += "(?:.*/)?";
          i = j + 1;
        } else {
          out += ".*";
          i = j;
        }
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      let j = i + 1;
      if (j < n && "!^".includes(pat.charAt(j)))
        j++;
      if (j < n && pat.charAt(j) === "]")
        j++;
      while (j < n && pat.charAt(j) !== "]")
        j++;
      let cls = pat.slice(i, j + 1);
      if (cls.startsWith("[!"))
        cls = `[^${cls.slice(2)}`;
      out += cls;
      i = j + 1;
    } else {
      out += escapeRegex(c);
      i++;
    }
  }
  return `${out}$`;
}
function matchPatterns(pats) {
  const pairs = [];
  for (const pat of pats) {
    for (const ex of expandBraces(pat))
      pairs.push([ex, new RegExp(globToRegex(ex))]);
  }
  return pairs;
}
var compileGlobs = (patterns) => matchPatterns(patterns).map(([, rx]) => rx);
function asList(v) {
  if (typeof v === "string")
    return [v];
  if (Array.isArray(v))
    return v;
  return [];
}
var hasMagic = (seg) => /[*?[]/.test(seg);
async function globExists(io, pattern) {
  const abs = pattern.startsWith("/");
  const segs = pattern.split("/").filter((s) => s !== "");
  return walk(io, abs ? "/" : "", segs, 0);
}
async function walk(io, dir, segs, i) {
  if (i >= segs.length)
    return dir === "" ? true : io.exists(dir);
  const seg = segs.at(i) ?? "";
  const here = dir === "" ? "." : dir;
  if (seg === "**") {
    if (i === segs.length - 1)
      return (await io.stat(here))?.kind === "dir";
    if (await walk(io, dir, segs, i + 1))
      return true;
    for (const e of await io.list(here)) {
      if (e.name.startsWith("."))
        continue;
      const sub = join(dir, e.name);
      if ((await io.stat(sub))?.kind === "dir" && await walk(io, sub, segs, i))
        return true;
    }
    return false;
  }
  if (!hasMagic(seg))
    return walk(io, join(dir, seg), segs, i + 1);
  const rx = new RegExp(globToRegex(seg));
  for (const e of await io.list(here)) {
    if (e.name.startsWith(".") && !seg.startsWith("."))
      continue;
    if (!rx.test(e.name))
      continue;
    if (await walk(io, join(dir, e.name), segs, i + 1))
      return true;
  }
  return false;
}

// src/i18n.ts
import i18next from "./vendor/i18next.js";
import { parse } from "./vendor/yaml.js";
import enYaml from "./vendor/locales-en.js";
import jaYaml from "./vendor/locales-ja.js";
var LANGS = ["ja", "en"];
var resources = {
  ja: parse(jaYaml),
  en: parse(enYaml)
};
var i18n = i18next.createInstance();
i18n.init({
  resources: { ja: { translation: resources.ja }, en: { translation: resources.en } },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: LANGS,
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false
});
var tr = (lang) => i18n.getFixedT(lang);
var isLang = (v) => v === "ja" || v === "en";
function langOfLocale(locale) {
  const v = (locale ?? "").trim();
  if (v === "")
    return;
  return /^ja(?![a-z])/i.test(v) ? "ja" : "en";
}
function resolveLang(env, configured) {
  if (isLang(configured))
    return configured;
  if (isLang(env.FEEDBACK_GATE_LANG))
    return env.FEEDBACK_GATE_LANG;
  for (const v of [env.FEEDBACK_GATE_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const lang = langOfLocale(v);
    if (lang)
      return lang;
  }
  return "en";
}

// src/load-yaml.ts
import { parse as parse2 } from "./vendor/yaml.js";
var PY_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
var PY_FALSE = /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/;
var pyBool = (original) => ({
  ...original,
  test: /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON|no|No|NO|false|False|FALSE|off|Off|OFF)$/,
  resolve: (str) => PY_TRUE.test(str) ? true : PY_FALSE.test(str) ? false : str
});
var parseYaml = (text) => parse2(text, {
  schema: "yaml-1.1",
  uniqueKeys: false,
  logLevel: "error",
  customTags: (tags) => tags.map((t) => typeof t === "object" && ("tag" in t) && t.tag === "tag:yaml.org,2002:bool" ? pyBool(t) : t)
});

// src/pyutil.ts
function truthy(v) {
  if (Array.isArray(v))
    return v.length > 0;
  if (v !== null && typeof v === "object")
    return Object.keys(v).length > 0;
  return Boolean(v);
}
function toCount(v) {
  if (!truthy(v))
    return 0;
  if (typeof v === "number")
    return Math.trunc(v);
  if (v === true)
    return 1;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v))
    return Number.parseInt(v, 10);
  return 0;
}
function pyRegExp(source, flags = "") {
  let src = source;
  let fl = flags;
  const m = /^\(\?([aiLmsux]+)\)/.exec(src);
  if (m) {
    src = src.slice(m[0].length);
    const pyFlags = m[1] ?? "";
    if (pyFlags.includes("x"))
      throw new Error(`unsupported Python inline flag (?x): ${source}`);
    for (const c of pyFlags)
      if ("ims".includes(c) && !fl.includes(c))
        fl += c;
  }
  src = replaceAnchors(src).replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>").replace(/\(\?P=([A-Za-z_]\w*)\)/g, "\\k<$1>");
  return new RegExp(src, fl);
}
function replaceAnchors(src) {
  let out = "";
  let inClass = false;
  for (let i = 0;i < src.length; i++) {
    const c = src.charAt(i);
    if (c === "\\") {
      const next = src.charAt(i + 1);
      if (!inClass && next === "A")
        out += "(?<![\\s\\S])";
      else if (!inClass && (next === "Z" || next === "z"))
        out += "(?![\\s\\S])";
      else
        out += c + next;
      i++;
      continue;
    }
    if (c === "[" && !inClass) {
      inClass = true;
      out += c;
      if (src.charAt(i + 1) === "^")
        out += src.charAt(++i);
      if (src.charAt(i + 1) === "]") {
        i++;
        out += "\\]";
      }
      continue;
    }
    if (c === "]" && inClass)
      inClass = false;
    out += c;
  }
  return out;
}
var isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// src/feedback-rules.ts
function feedbackDir(io) {
  const override = io.env.CLAUDE_FEEDBACK_DIR;
  if (override)
    return override;
  return join(io.homeConfigDir, "feedback");
}
function feedbackDirs(io) {
  const override = io.env.CLAUDE_FEEDBACK_DIR;
  if (override)
    return [override];
  return configPaths(io, io.env.HOME || "~", "feedback");
}
var projectFeedbackDirs = (io, projectDir) => configPaths(io, projectDir || io.projectDir || io.cwd, "feedback");
var violationsLogPath = (io) => join(feedbackDir(io), ".violations.jsonl");
var errorsLogPath = (io) => join(feedbackDir(io), ".errors.jsonl");
var FRONTMATTER_RE = /^---\s*\n([\s\S]*?\n)---\s*\n?/;
var loadYamlText = (text) => parseYaml(text);
var DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
var DAY_MS = 86400000;
function parseExpires(v) {
  if (v instanceof Date) {
    const t = v.getTime();
    if (Number.isNaN(t))
      return;
    return t % DAY_MS === 0 ? t + DAY_MS - 1 : t;
  }
  if (typeof v !== "string")
    return;
  const text = v.trim();
  const t = Date.parse(text);
  if (Number.isNaN(t))
    return;
  return DATE_ONLY_RE.test(text) ? t + DAY_MS - 1 : t;
}
var stringList = (v) => asList(v).filter((x) => typeof x === "string");
var typeName = (v) => v === null || v === undefined ? "null" : Array.isArray(v) ? "list" : isDict(v) ? "mapping" : typeof v;
var REGEX_FLAGS = { pre_bash: "", pre_edit: "m", post_edit: "m" };
function normalizeEnforce(io, raw) {
  const t = tr(io.lang);
  const problems = [];
  if (!truthy(raw))
    return { enforce: [], problems };
  if (!Array.isArray(raw))
    return { enforce: [], problems: [t("rules.enforceNotList", { type: typeName(raw) })] };
  const enforce = [];
  raw.forEach((entry, index) => {
    if (!isDict(entry)) {
      problems.push(t("rules.enforceItemNotMapping", { index, type: typeName(entry) }));
      return;
    }
    const flags = typeof entry.event === "string" ? REGEX_FLAGS[entry.event] : undefined;
    if (flags !== undefined) {
      for (const key of ["when", "unless"]) {
        const v = entry[key];
        if (!truthy(v))
          continue;
        try {
          pyRegExp(String(v), flags);
        } catch (e) {
          problems.push(t("rules.badRegex", { index, key, error: errorText(e) }));
          return;
        }
      }
    }
    enforce.push(entry);
  });
  return { enforce, problems };
}
var errorText = (e) => (e instanceof Error ? e.message : String(e)).split(`
`)[0]?.trim() ?? "";
async function loadRule(io, path) {
  const content = await io.readFile(path);
  if (content === undefined)
    return null;
  const m = FRONTMATTER_RE.exec(content);
  if (!m)
    return null;
  const data = loadYamlText(m[1] ?? "");
  if (!isDict(data) || !truthy(data.name))
    return null;
  const files = stringList(data.files);
  const excludeFiles = stringList(data.exclude_files);
  const { enforce, problems } = normalizeEnforce(io, data.enforce);
  return {
    name: String(data.name),
    description: truthy(data.description) ? String(data.description) : "",
    count: toCount(data.count),
    enforce: inheritFiles(enforce, files, excludeFiles),
    ...problems.length > 0 ? { problems } : {},
    path,
    expires: parseExpires(data.expires),
    projects: stringList(data.projects),
    whenExists: stringList(data.when_exists),
    files,
    excludeFiles
  };
}
var PATH_EVENTS = new Set(["pre_edit", "post_edit"]);
function inheritFiles(enforce, files, excludeFiles) {
  if (files.length === 0)
    return enforce;
  return enforce.map((entry) => {
    if (typeof entry.event !== "string" || !PATH_EVENTS.has(entry.event) || truthy(entry.path))
      return entry;
    const out = { ...entry, path: [...files] };
    if (!truthy(entry.exclude_path) && excludeFiles.length > 0)
      out.exclude_path = [...excludeFiles];
    return out;
  });
}
function expandTilde(io, pattern) {
  const home = io.env.HOME;
  if (!home || pattern !== "~" && !pattern.startsWith("~/"))
    return pattern;
  return join(home, pattern.slice(2));
}
async function isRuleActive(io, rule, projectDir) {
  if (rule.expires !== undefined && await io.now() > rule.expires)
    return false;
  const dir = projectDir || io.projectDir || io.cwd;
  if (rule.projects.length > 0) {
    const rxs = compileGlobs(rule.projects.map((p) => expandTilde(io, p)));
    if (!rxs.some((rx) => rx.test(dir)))
      return false;
  }
  if (rule.whenExists.length > 0) {
    let found = false;
    for (const pattern of rule.whenExists) {
      for (const expanded of expandBraces(pattern)) {
        if (await globExists(io, join(dir, expanded))) {
          found = true;
          break;
        }
      }
      if (found)
        break;
    }
    if (!found)
      return false;
  }
  return true;
}
async function listRulesInAll(io, dirs, broken) {
  const out = [];
  const seen = new Set;
  for (const dir of dirs) {
    for (const rule of await listRulesIn(io, dir, broken)) {
      if (seen.has(rule.name))
        continue;
      seen.add(rule.name);
      out.push(rule);
    }
  }
  return out;
}
async function listRulesIn(io, d, broken) {
  const rules = [];
  const names = (await io.list(d)).map((e) => e.name).sort();
  for (const name of names) {
    if (!name.endsWith(".md"))
      continue;
    const path = join(d, name);
    try {
      const rule = await loadRule(io, path);
      if (rule)
        rules.push(rule);
    } catch (e) {
      broken.push({ path, reason: tr(io.lang)("rules.unreadable", { error: errorText(e) }) });
    }
  }
  return rules;
}
var problemsOf = (rules) => rules.flatMap((r) => (r.problems ?? []).map((reason) => ({ path: r.path, reason })));
async function listRules(io, feedbackDirPath) {
  const { rules, broken } = await scanRules(io, feedbackDirPath);
  for (const b of broken)
    await logError(io, "rules", b.reason, b.path);
  return rules;
}
async function scanRules(io, feedbackDirPath) {
  const broken = [];
  if (feedbackDirPath) {
    const rules = await listRulesIn(io, feedbackDirPath, broken);
    return { rules, broken: [...broken, ...problemsOf(rules)] };
  }
  const globalDirs = feedbackDirs(io);
  const projectDirs = projectFeedbackDirs(io).filter((d) => !globalDirs.includes(d));
  const globalRules = await listRulesInAll(io, globalDirs, broken);
  const projectRules = await listRulesInAll(io, projectDirs, broken);
  const overridden = new Set(projectRules.map((r) => r.name));
  const merged = [...globalRules.filter((r) => !overridden.has(r.name)), ...projectRules];
  const active = [];
  for (const r of merged)
    if (await isRuleActive(io, r))
      active.push(r);
  return { rules: active, broken: [...broken, ...problemsOf(active)] };
}
var logQueue = Promise.resolve();
function logError(io, source, error, file) {
  const task = logQueue.then(async () => {
    try {
      const path = errorsLogPath(io);
      const existing = await io.readFile(path) ?? "";
      const same = (line) => {
        try {
          const d = JSON.parse(line);
          return isDict(d) && d.source === source && d.error === error && (d.file ?? undefined) === file;
        } catch {
          return false;
        }
      };
      if (existing.split(`
`).some(same))
        return;
      const ts = new Date(await io.now()).toISOString().replace("Z", "+00:00");
      const entry = { ts, source, ...file !== undefined ? { file } : {}, error };
      await io.writeFile(path, `${existing}${JSON.stringify(entry)}
`);
    } catch {}
  });
  logQueue = task;
  return task;
}
var COUNT_LINE_RE = /^count:[ \t]*(\d+)[ \t]*(?=\r?$)/m;
function readCountLine(content) {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm)
    return;
  const m = COUNT_LINE_RE.exec(fm[0]);
  return m ? Number(m[1]) : undefined;
}
function replaceCountLine(content, to) {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm)
    return;
  const head = fm[0];
  if (!COUNT_LINE_RE.test(head))
    return;
  return head.replace(COUNT_LINE_RE, `count: ${to}`) + content.slice(head.length);
}
async function writeFileAtomic(io, path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${Math.floor(await io.now())}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await io.writeFile(tmp, text);
    const r = await io.run(["mv", "-f", "--", tmp, path], { timeoutMs: 5000 });
    if (r.exitCode === 0 && !r.timedOut && r.error === undefined)
      return;
  } catch {}
  await io.removeFiles([tmp]).catch(() => {
    return;
  });
  await io.writeFile(path, text);
}

// src/correct.ts
var HOUR_MS = 3600000;
var DAY_MS2 = 86400000;
var DEFAULT_WINDOW_MS = 30 * DAY_MS2;
var DEFAULT_MIN = 2;
function parseCorrectArgs(args) {
  const out = { window: DEFAULT_WINDOW_MS, apply: false, min: DEFAULT_MIN };
  const tokens = args.split(/\s+/).filter((t) => t !== "");
  for (let i = 0;i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    if (key === "apply" && eq < 0) {
      out.apply = true;
    } else if (key === "--window" || key === "--min") {
      const inline = eq >= 0;
      const value = inline ? token.slice(eq + 1) : tokens[i + 1] ?? "";
      const parsed = key === "--window" ? parseWindow(value) : parseMin(value);
      if (parsed === undefined)
        continue;
      if (key === "--window")
        out.window = parsed;
      else
        out.min = parsed;
      if (!inline)
        i++;
    }
  }
  return out;
}
function parseWindow(v) {
  const m = /^(\d+)([dh])$/.exec(v);
  if (!m)
    return;
  const n = Number(m[1]);
  return n > 0 ? n * (m[2] === "d" ? DAY_MS2 : HOUR_MS) : undefined;
}
function parseMin(v) {
  if (!/^\d+$/.test(v))
    return;
  const n = Number(v);
  return n > 0 ? n : undefined;
}
function windowLabel(ms) {
  return ms % DAY_MS2 === 0 ? `${ms / DAY_MS2}d` : `${Math.round(ms / HOUR_MS)}h`;
}
async function readViolations(io) {
  const text = await io.readFile(violationsLogPath(io));
  if (text === undefined)
    return [];
  const entries = [];
  for (const line of text.split(`
`)) {
    if (line.trim() === "")
      continue;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data))
      continue;
    const d = data;
    if (typeof d.rule !== "string" || d.rule === "")
      continue;
    entries.push({
      ts: typeof d.ts === "string" ? d.ts : "",
      rule: d.rule,
      count: typeof d.count === "number" ? d.count : 0,
      severity: typeof d.severity === "string" ? d.severity : "",
      event: typeof d.event === "string" ? d.event : "",
      detail: typeof d.detail === "string" ? d.detail : ""
    });
  }
  return entries;
}
var bump = (rec, key) => {
  if (key !== "")
    rec[key] = (rec[key] ?? 0) + 1;
};
function aggregateViolations(entries, now, windowMs) {
  const stats = new Map;
  const details = new Map;
  const since = now - windowMs;
  for (const e of entries) {
    let s = stats.get(e.rule);
    if (!s) {
      s = { total: 0, inWindow: 0, bySeverity: {}, byEvent: {} };
      stats.set(e.rule, s);
    }
    s.total++;
    const t = Date.parse(e.ts);
    if (e.ts !== "" && (s.lastTs === undefined || t > Date.parse(s.lastTs)))
      s.lastTs = e.ts;
    if (Number.isNaN(t) || t < since)
      continue;
    s.inWindow++;
    bump(s.bySeverity, e.severity);
    bump(s.byEvent, e.event);
    if (e.detail !== "") {
      const d = details.get(e.rule) ?? new Map;
      d.set(e.detail, (d.get(e.detail) ?? 0) + 1);
      details.set(e.rule, d);
    }
  }
  for (const [rule, d] of details) {
    let top;
    let best = 0;
    for (const [detail, n] of d) {
      if (n > best) {
        best = n;
        top = detail;
      }
    }
    const s = stats.get(rule);
    if (s && top !== undefined)
      s.topDetail = top;
  }
  return stats;
}
var enforceTemplate = (lang) => tr(lang)("correct.enforceTemplate");
var oneLine = (s, max = 60) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
var countsText = (rec) => Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
function inactiveReason(rule, now, lang) {
  const t = tr(lang);
  if (rule.expires !== undefined && now > rule.expires)
    return t("correct.expired", { date: new Date(rule.expires).toISOString().slice(0, 10) });
  const parts = [];
  if (rule.projects.length > 0)
    parts.push("projects");
  if (rule.whenExists.length > 0)
    parts.push("when_exists");
  return t("correct.notMatching", { what: parts.join(" / ") || t("correct.conditions") });
}
function buildProposals(rules, inactive, stats, opts, broken = []) {
  const bumps = [];
  const enforces = [];
  const stales = [];
  const expireds = [];
  const label = windowLabel(opts.window);
  const t = tr(opts.lang);
  for (const rule of rules) {
    const s = stats.get(rule.name);
    const n = s?.inWindow ?? 0;
    if (n >= opts.min && s) {
      const top = s.topDetail ? t("correct.topDetail", { detail: oneLine(s.topDetail) }) : "";
      if (rule.count < 3) {
        bumps.push({
          kind: "bump",
          rule: rule.name,
          path: rule.path,
          from: rule.count,
          to: 3,
          n,
          reason: t("correct.bumpToConfirmed", { window: label, n, counts: countsText(s.bySeverity), top })
        });
      } else if (rule.count < 5) {
        const strong = (s.bySeverity.ask ?? 0) + (s.bySeverity.block ?? 0);
        if (strong >= opts.min) {
          bumps.push({
            kind: "bump",
            rule: rule.name,
            path: rule.path,
            from: rule.count,
            to: 5,
            n,
            reason: t("correct.bumpToDeny", { window: label, strong, counts: countsText(s.bySeverity), top })
          });
        }
      }
    }
    if (rule.count >= 3 && rule.enforce.length === 0) {
      enforces.push({
        kind: "enforce",
        rule: rule.name,
        path: rule.path,
        reason: t("correct.noEnforce", { count: rule.count }),
        template: enforceTemplate(opts.lang)
      });
    }
    if (rule.count >= 3 && rule.enforce.length > 0 && n === 0 && (s?.total ?? 0) === 0) {
      stales.push({
        kind: "stale",
        rule: rule.name,
        path: rule.path,
        reason: t("correct.stale")
      });
    }
  }
  for (const rule of inactive) {
    expireds.push({
      kind: "expired",
      rule: rule.name,
      path: rule.path,
      reason: t("correct.expiredAction", { reason: inactiveReason(rule, opts.now, opts.lang) })
    });
  }
  const brokens = broken.map((b) => ({
    kind: "broken",
    rule: basename(b.path).replace(/\.md$/, ""),
    path: b.path,
    reason: t("correct.broken", { reason: b.reason })
  }));
  bumps.sort((a, b) => b.to - a.to || b.n - a.n);
  return [...brokens, ...bumps.map(({ n: _n, ...p }) => p), ...enforces, ...stales, ...expireds];
}
function formatReport(proposals, stats, opts, rulesCount, applied) {
  const t = tr(opts.lang);
  let violations = 0;
  for (const s of stats.values())
    violations += s.inWindow;
  const lines = [t("correct.reportHeader", { window: windowLabel(opts.window), rules: rulesCount, violations })];
  if (proposals.length === 0) {
    lines.push(t("correct.noProposals"));
  } else {
    for (const p of proposals) {
      const head = p.kind === "bump" ? `${p.rule}: count ${p.from} → ${p.to}` : p.rule;
      lines.push(`- [${p.kind}] ${head}`, `    ${p.reason}`, `    ${p.path}`);
    }
  }
  if (opts.apply) {
    lines.push(t(!applied || applied.length === 0 ? "correct.applyNone" : "correct.applyDone"));
    for (const a of applied ?? [])
      lines.push(`  - ${a.path} (count ${a.from} → ${a.to})`);
  } else {
    lines.push(t("correct.applyHint"));
  }
  return lines.join(`
`);
}
async function applyCountBumps(io, proposals) {
  const applied = [];
  for (const p of proposals) {
    if (p.kind !== "bump")
      continue;
    const content = await io.readFile(p.path);
    if (content === undefined || readCountLine(content) !== p.from)
      continue;
    const next = replaceCountLine(content, p.to);
    if (next === undefined)
      continue;
    await writeFileAtomic(io, p.path, next);
    applied.push({ path: p.path, from: p.from, to: p.to });
  }
  return applied;
}
function buildContext(proposals, applied, lang) {
  if (proposals.length === 0)
    return [];
  const t = tr(lang);
  const lines = [t("correct.context")];
  if (applied.length > 0)
    lines.push(t("correct.contextApplied", { list: applied.map((a) => `${a.path} (${a.from} → ${a.to})`).join(", ") }));
  return [lines.join(`
`)];
}
async function listInactive(io, active) {
  const dirs = [...new Set([...feedbackDirs(io), ...projectFeedbackDirs(io)])];
  const activeNames = new Set(active.map((r) => r.name));
  const seen = new Set;
  const out = [];
  for (const dir of dirs) {
    for (const rule of await listRules(io, dir)) {
      if (seen.has(rule.path))
        continue;
      seen.add(rule.path);
      if (activeNames.has(rule.name))
        continue;
      if (!await isRuleActive(io, rule))
        out.push(rule);
    }
  }
  return out;
}
async function correctCommand(io, args) {
  try {
    const parsed = parseCorrectArgs(args);
    const now = await io.now();
    const { rules, broken } = await scanRules(io);
    for (const b of broken)
      await logError(io, "rules", b.reason, b.path);
    const inactive = await listInactive(io, rules);
    const stats = aggregateViolations(await readViolations(io), now, parsed.window);
    const opts = { window: parsed.window, min: parsed.min, now, lang: io.lang };
    const proposals = buildProposals(rules, inactive, stats, opts, broken);
    const applied = parsed.apply ? await applyCountBumps(io, proposals) : undefined;
    return {
      text: formatReport(proposals, stats, { window: parsed.window, apply: parsed.apply, lang: io.lang }, rules.length, applied),
      context: buildContext(proposals, applied ?? [], io.lang)
    };
  } catch (e) {
    await logError(io, "correct", e instanceof Error ? e.message : String(e));
    return { text: `[correct] internal error: ${e instanceof Error ? e.message : String(e)}`, context: [] };
  }
}

// src/engine-io.ts
var errorText2 = (e) => e instanceof Error ? e.message : String(e);
async function readEnv($) {
  const [
    HOME,
    PATH,
    CLAUDE_FEEDBACK_DIR,
    DOGWOOD_BIN,
    TERM_PROGRAM,
    __CFBundleIdentifier,
    FEEDBACK_GATE_LANG,
    FEEDBACK_GATE_ASK_AGENT_TYPES,
    FEEDBACK_GATE_ALLOW_RECIPIENTS,
    LC_ALL,
    LC_MESSAGES,
    LANG
  ] = await Promise.all([
    $.env.get("HOME"),
    $.env.get("PATH"),
    $.env.get("CLAUDE_FEEDBACK_DIR"),
    $.env.get("DOGWOOD_BIN"),
    $.env.get("TERM_PROGRAM"),
    $.env.get("__CFBundleIdentifier"),
    $.env.get("FEEDBACK_GATE_LANG"),
    $.env.get("FEEDBACK_GATE_ASK_AGENT_TYPES"),
    $.env.get("FEEDBACK_GATE_ALLOW_RECIPIENTS"),
    $.env.get("LC_ALL"),
    $.env.get("LC_MESSAGES"),
    $.env.get("LANG")
  ]);
  return {
    HOME,
    PATH,
    CLAUDE_FEEDBACK_DIR,
    DOGWOOD_BIN,
    TERM_PROGRAM,
    __CFBundleIdentifier,
    FEEDBACK_GATE_LANG,
    FEEDBACK_GATE_ASK_AGENT_TYPES,
    FEEDBACK_GATE_ALLOW_RECIPIENTS,
    LC_ALL,
    LC_MESSAGES,
    LANG
  };
}
async function createIo($, options = {}) {
  const [env, projectDir, cwd] = await Promise.all([readEnv($), $.session.root(), $.session.cwd()]);
  const lang = resolveLang(env, options.language);
  const exists = (path) => $.fs.exists(path).catch(() => false);
  const [projectConfigDir, homeConfigDir] = await Promise.all([
    pickConfigDir(CLAUDE_CONFIG_DIRS, projectDir, exists),
    pickConfigDir(CLAUDE_CONFIG_DIRS, env.HOME || "~", exists)
  ]);
  const stat = async (path) => {
    try {
      const s = await $.fs.stat(path);
      return { kind: s.kind, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return;
    }
  };
  const run = async (argv, options = {}) => {
    try {
      const r = await $.process.run(argv, {
        ...options.cwd !== undefined ? { cwd: options.cwd } : {},
        ...options.env !== undefined ? { env: options.env } : {},
        ...options.stdin !== undefined ? { stdin: options.stdin } : {},
        ...options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false };
    } catch (e) {
      return { exitCode: 1, stdout: "", stderr: "", timedOut: false, error: errorText2(e) };
    }
  };
  const existing = async (paths) => {
    const found = [];
    for (const p of paths)
      if (await $.fs.exists(p).catch(() => false))
        found.push(p);
    return found;
  };
  return {
    env,
    lang,
    autoCount: options.autoCount !== false,
    projectDir,
    cwd,
    pluginRoot: $.plugin.root,
    configDirNames: CLAUDE_CONFIG_DIRS,
    projectConfigDir,
    homeConfigDir,
    readFile: (path) => $.fs.read(path).then(String, () => {
      return;
    }),
    writeFile: (path, text) => $.fs.write(path, text),
    exists,
    stat,
    list: async (path) => {
      try {
        return (await $.fs.list(path)).map((e) => ({ name: e.name, kind: e.kind, mtimeMs: e.mtimeMs }));
      } catch {
        return [];
      }
    },
    isExecutable: async (path) => (await stat(path))?.kind === "file",
    removeFiles: async (paths) => {
      const found = await existing(paths);
      if (found.length > 0)
        await run(["rm", "-f", "--", ...found]);
    },
    removeDir: async (path) => {
      if ((await stat(path))?.kind === "dir")
        await run(["rmdir", "--", path]);
    },
    removeTree: async (path) => {
      if (await $.fs.exists(path).catch(() => false))
        await run(["rm", "-rf", "--", path]);
    },
    run,
    now: () => $.clock.now(),
    progress: (text) => $.ui.status(text),
    result: (text) => $.ui.status(text),
    redraw: () => $.ui.invalidate("ui.render"),
    every: (ms, fn) => {
      const timer = $.clock.every(ms, fn);
      return () => timer.cancel();
    }
  };
}

// src/outcome.ts
var TEXT_CONTEXT_EVENTS = new Set(["UserPromptSubmit", "SessionStart"]);
var parseJson = (text) => {
  const t = text.trim();
  if (!t.startsWith("{"))
    return;
  try {
    const v = JSON.parse(t);
    return isDict(v) ? v : undefined;
  } catch {
    return;
  }
};
var fromJson = (event, json) => {
  const out = {};
  if (json.decision === "block")
    out.block = String(json.reason ?? "");
  if (json.continue === false) {
    out.preventContinuation = true;
    if (typeof json.stopReason === "string")
      out.stopReason = json.stopReason;
  }
  if (typeof json.systemMessage === "string" && json.systemMessage !== "")
    out.systemMessage = json.systemMessage;
  const specific = json.hookSpecificOutput;
  if (isDict(specific)) {
    if (typeof specific.additionalContext === "string" && specific.additionalContext !== "") {
      out.additionalContext = [specific.additionalContext];
    }
    if (event === "PreToolUse") {
      const reason = String(specific.permissionDecisionReason ?? "");
      if (specific.permissionDecision === "allow")
        out.allow = true;
      else if (specific.permissionDecision === "ask")
        out.ask = reason;
      else if (specific.permissionDecision === "deny")
        out.deny = reason;
    }
  }
  return out;
};
var toOutcome = (event, ran) => {
  if (ran.exitCode === 2) {
    const reason = ran.stderr.trim() || "hook exited with code 2";
    return event === "PreToolUse" ? { deny: reason } : { block: reason };
  }
  if (ran.exitCode !== 0)
    return {};
  const base = toOutcomeStdout(event, ran.stdout);
  return ran.systemMessage ? { ...base, systemMessage: ran.systemMessage } : base;
};
var toOutcomeStdout = (event, stdout) => {
  const json = parseJson(stdout);
  if (json)
    return fromJson(event, json);
  const text = stdout.trim();
  return text !== "" && TEXT_CONTEXT_EVENTS.has(event) ? { additionalContext: [text] } : {};
};
var merge = (first, second) => {
  const out = { ...second, ...first };
  const ctx = [...first.additionalContext ?? [], ...second.additionalContext ?? []];
  if (ctx.length > 0)
    out.additionalContext = ctx;
  else
    delete out.additionalContext;
  const sys = [first.systemMessage, second.systemMessage].filter((m) => m !== undefined && m !== "");
  if (sys.length > 0)
    out.systemMessage = sys.join(`
`);
  else
    delete out.systemMessage;
  return out;
};

// src/go-bridge.ts
var EVENT_LINE_PREFIX = "@@feedback-gate ";
function optionEnv(options) {
  const env = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
      env[`CLAUDE_PLUGIN_OPTION_${key}`] = String(value);
  }
  return env;
}
function applyEventLine(line, screen) {
  if (!line.startsWith(EVENT_LINE_PREFIX))
    return false;
  try {
    const ev = JSON.parse(line.slice(EVENT_LINE_PREFIX.length));
    if (isDict(ev)) {
      for (const key of ["progress", "result"]) {
        if (typeof ev[key] === "string")
          screen.status(ev[key] === "" ? undefined : ev[key]);
      }
      if (ev.redraw === true)
        screen.redraw();
    }
  } catch {}
  return true;
}
async function collect(chunks, screen) {
  let stdout = "";
  let stderr = "";
  let partial = "";
  for await (const chunk of chunks) {
    if (chunk.stream === "stdout") {
      stdout += chunk.text;
      continue;
    }
    const lines = (partial + chunk.text).split(`
`);
    partial = lines.pop() ?? "";
    for (const line of lines)
      if (!applyEventLine(line, screen))
        stderr += `${line}
`;
  }
  if (partial !== "" && !applyEventLine(partial, screen))
    stderr += partial;
  return { stdout, stderr };
}
function classicPayload(event, payload, sessionId, cwd) {
  return { session_id: sessionId, cwd, hook_event_name: event, ...payload };
}
async function runGo($, options, event, payload) {
  try {
    const [sessionId, root, cwd] = await Promise.all([$.session.id(), $.session.root(), $.session.cwd()]);
    const screen = { status: (text) => $.ui.status(text), redraw: () => $.ui.invalidate("ui.render") };
    const chunks = $.process.spawn({
      argv: ["bash", join($.plugin.root, "scripts", "hook.sh"), event],
      cwd,
      env: {
        ...optionEnv(options),
        CLAUDE_PLUGIN_ROOT: $.plugin.root,
        CLAUDE_PROJECT_DIR: root,
        FEEDBACK_GATE_FROM_MOD: "1",
        FEEDBACK_GATE_EVENTS: "stderr"
      },
      input: JSON.stringify(classicPayload(event, payload, sessionId, cwd))
    });
    const { stdout, stderr } = await collect(chunks, screen);
    return toOutcome(event, { exitCode: 0, stdout, stderr });
  } catch {
    return {};
  }
}

// src/hook-list.ts
var TIMEOUT_MS = 120000;
function optionEnv2(options) {
  const env = {};
  for (const key of ["language", "agentLaunchGuard", "autoCount", "rulesFile"]) {
    const v = options[key];
    if (typeof v === "string" || typeof v === "boolean")
      env[`CLAUDE_PLUGIN_OPTION_${key}`] = String(v);
  }
  return env;
}
var PASS_ENV = ["HOME", "CLAUDE_FEEDBACK_DIR", "FEEDBACK_GATE_LANG", "LC_ALL", "LC_MESSAGES", "LANG"];
function passEnv(io) {
  const env = {};
  for (const key of PASS_ENV) {
    const v = io.env[key];
    if (v !== undefined && v !== "")
      env[key] = v;
  }
  return env;
}
async function hookListCommand(io, args, options = {}) {
  const argv = ["bash", join(io.pluginRoot, "scripts", "hook-list.sh"), "claude", ...args.split(/\s+/).filter((a) => a !== "")];
  const r = await io.run(argv, {
    cwd: io.cwd,
    env: { ...passEnv(io), ...optionEnv2(options), CLAUDE_PROJECT_DIR: io.projectDir || io.cwd, CLAUDE_PLUGIN_ROOT: io.pluginRoot },
    timeoutMs: TIMEOUT_MS
  });
  const out = r.stdout.trim();
  if (r.exitCode === 0 && out !== "")
    return { text: out, context: [] };
  const reason = [r.stderr.trim(), r.error ?? "", r.timedOut ? "timed out" : ""].filter((s) => s !== "").join(`
`);
  return { text: `[hook-list] failed (exit ${r.exitCode})${reason === "" ? "" : `:
${reason}`}`, context: [] };
}

// src/running-registry.ts
var MAX_RUN_MS = 600000;
var STALE_MS = MAX_RUN_MS + 60000;
var gateStatusDir = (io) => join(io.projectConfigDir, ".gate-status");
var runningDir = (io) => join(gateStatusDir(io), "running");
function mergeRunning(texts, now) {
  const groups = [];
  for (const text of texts) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const entries = (Array.isArray(parsed) ? parsed : []).filter(isDict);
    if (entries.length === 0 || Math.max(...entries.map((e) => e.started)) < now - STALE_MS)
      continue;
    groups.push(entries);
  }
  groups.sort((a, b) => a[0].started - b[0].started);
  return groups.flat();
}
var ownedBySession = (name, sessionId) => name.startsWith(`${sessionId}.`) || name.startsWith(`${sessionId}--`);
async function listRunning(io, sessionId) {
  const now = await io.now();
  const texts = [];
  for (const f of await io.list(runningDir(io))) {
    if (f.kind !== "file" || !f.name.endsWith(".json") || !ownedBySession(f.name, sessionId))
      continue;
    const text = await io.readFile(join(runningDir(io), f.name));
    if (text !== undefined)
      texts.push(text);
  }
  return mergeRunning(texts, now);
}
var BAND_LINE_MAX = 80;
var INDENT = "  ";
var ELLIPSIS = " ...";
function foldCmd(cmd) {
  const lines = cmd.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return `${lines[0] ?? ""}${lines.length > 1 ? ELLIPSIS : ""}`;
}
function cutCmd(text, room) {
  if (text.length <= room)
    return text;
  const limit = Math.max(0, room - ELLIPSIS.length);
  let head = text.slice(0, limit);
  if (text[limit] !== " ") {
    const space = head.lastIndexOf(" ");
    if (space > 0)
      head = head.slice(0, space);
  }
  return `${head.trimEnd()}${ELLIPSIS}`;
}
var markOf = (e) => e.result === "ok" ? "✓" : "✗";
var doneText = (e, now) => `${e.name ?? foldCmd(e.cmd)} ${markOf(e)} (${(((e.ended ?? now) - e.started) / 1000).toFixed(1)}s)`;
function runningLine(e, now, lang) {
  if (e.result)
    return `${INDENT}${doneText(e, now)}`;
  const seconds = Math.max(0, Math.floor((now - e.started) / 1000));
  const head = e.name ? `${INDENT}${e.name} $ ` : INDENT;
  const tail = `${e.waiting ? ` ${tr(lang)("band.waiting")}` : ""} (${seconds}s)`;
  return `${head}${cutCmd(foldCmd(e.cmd), BAND_LINE_MAX - head.length - tail.length)}${tail}`;
}
function runningLines(entries, now, lang) {
  return [tr(lang)("band.running"), ...entries.map((e) => runningLine(e, now, lang))];
}
function runningBand(entries, now, lang) {
  if (!entries.some((e) => !e.result))
    return;
  return {
    type: "Box",
    props: { flexDirection: "column" },
    children: runningLines(entries, now, lang).map((line) => ({ type: "Text", children: [line] }))
  };
}

// src/register.ts
var str = (v) => typeof v === "string" ? v : "";
async function withNext(next, e, mine) {
  const rest = await next(e);
  return merge(mine, rest);
}
async function markClassic($, options, refresh = false) {
  try {
    const sessionId = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, "");
    if (sessionId === "")
      return;
    const io = await createIo($, options);
    const marker = join(feedbackDir(io), ".classic_seen", sessionId);
    if (refresh || !await io.exists(marker))
      await io.writeFile(marker, `1
`);
  } catch {}
}
function preToolUsePayload(event, tool, sessionId, cwd) {
  const { tool: _tool, tool_use_id, agentId, ...toolInput } = event;
  const payload = {
    session_id: sessionId,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id
  };
  if (typeof agentId === "string" && agentId !== "")
    payload.agent_id = agentId;
  return payload;
}
var guardsTool = (options, tool) => options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool) || /^(Bash|Edit|Write|MultiEdit)$/.test(tool);
var POST_TOOLS = /^(Read|Bash|Edit|Write|MultiEdit|Agent|Task)$/;
export const register = (on, options) => {
  on("session.start", async ($, e, next) => {
    try {
      const io = await createIo($, options);
      await $.command.register({
        name: "correct",
        description: tr(io.lang)("correct.description"),
        argumentHint: "[--window 30d] [--min 2] [apply]"
      });
      await $.command.register({ name: "hook-list", description: tr(io.lang)("hookList.description"), argumentHint: "[--no-open]" });
    } catch {}
    return next(e);
  });
  on("command.run", { command: "correct" }, async ($, e) => correctCommand(await createIo($, options), String(e.args ?? "")));
  on("command.run", { command: "hook-list" }, async ($, e) => hookListCommand(await createIo($, options), String(e.args ?? ""), options));
  on("classic.SessionStart", async ($, e, next) => {
    await markClassic($, options);
    return withNext(next, e, await runGo($, options, "SessionStart", e));
  });
  on("classic.UserPromptSubmit", async ($, e, next) => {
    await markClassic($, options);
    return withNext(next, e, await runGo($, options, "UserPromptSubmit", e));
  });
  on("classic.PreToolUse", async ($guard, guardEvent, guardNext) => {
    await markClassic($guard, options);
    const tool = str(guardEvent.tool);
    if (!guardsTool(options, tool))
      return guardNext(guardEvent);
    const payload = preToolUsePayload(guardEvent, tool, await $guard.session.id(), await $guard.session.cwd());
    const mine = await runGo($guard, options, "PreToolUse", payload);
    if (mine.deny !== undefined)
      return { deny: mine.deny };
    if (mine.ask !== undefined)
      return { ask: mine.ask };
    return guardNext(guardEvent);
  });
  on("classic.PostToolUse", async ($, e, next) => {
    await markClassic($, options);
    if (!POST_TOOLS.test(str(e.tool_name)))
      return next(e);
    return withNext(next, e, await runGo($, options, "PostToolUse", e));
  });
  on("classic.Notification", async ($, e, next) => {
    await markClassic($, options, true);
    await runGo($, options, "Notification", e);
    return next(e);
  });
  on("classic.Stop", async ($, e, next) => {
    await markClassic($, options);
    return withNext(next, e, await runGo($, options, "Stop", e));
  });
  on("classic.SubagentStop", async ($, e, next) => {
    await markClassic($, options);
    return withNext(next, e, await runGo($, options, "SubagentStop", e));
  });
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey)
      return next(e);
    const io = await createIo($, options);
    return runningBand(await listRunning(io, await $.session.id()), await io.now(), io.lang) ?? next(e);
  });
};
