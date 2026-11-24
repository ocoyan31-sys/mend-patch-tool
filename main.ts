// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own break, its lines, and whether it ends with the break (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => rstripWs(s.replace(/^[ \t]+/, ''));

/** Line equality at a matching tier (SPEC.md section 5). */
function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

const tiersOf = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

/** Every position at or after `from` where `old` matches `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!eqTier(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** One line of a hunk or chunk body: ` ` context, `-` old, `+` new, `\` marker; `empty` marks a blank raw line. */
interface BodyLine {
  t: string;
  text: string;
  empty?: boolean;
}

function oldTexts(body: BodyLine[]): string[] {
  return body.filter((e) => e.t === ' ' || e.t === '-').map((e) => e.text);
}

/** The lines a matched body writes at `pos`: context lines are the file's own; new lines are the patch's, re-indented at tier 2. */
function writtenLines(lines: string[], pos: number, body: BodyLine[], tier: number): string[] {
  const olds = oldTexts(body);
  const f = tier === 2 && olds.length > 0 ? leadWs(lines[pos]!) : '';
  const p = tier === 2 && olds.length > 0 ? leadWs(olds[0]!) : '';
  const out: string[] = [];
  let k = pos;
  for (const e of body) {
    if (e.t === ' ') {
      out.push(lines[k]!);
      k += 1;
    } else if (e.t === '-') {
      k += 1;
    } else if (e.t === '+') {
      let s = e.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

/** True when a `\` line follows the body's last context or `+` line. */
function noBreakAfter(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const t = body[i]!.t;
    if (t === ' ' || t === '+') return i + 1 < body.length && body[i + 1]!.t === '\\';
  }
  return false;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Apply one section's hunks (SPEC.md section 6) to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const m = splitFile(text);
  let lines = m.lines;
  let fin = m.final;
  let d = 0;
  for (const h of hunks) {
    const olds = oldTexts(h.body);
    const news = h.body.filter((e) => e.t === ' ' || e.t === '+').length;
    if (olds.length === 0 && news === 0) continue;
    if (olds.length > 0) {
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of tiersOf(strict)) {
        const occ = occurrences(lines, olds, tier, 0);
        if (occ.length === 0) continue;
        const target = h.a - 1 + d;
        let best = occ[0]!;
        for (const o of occ) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
        placed = { tier, pos: best };
        break;
      }
      if (placed === null) throw new Fail('no-match', path);
      const repl = writtenLines(lines, placed.pos, h.body, placed.tier);
      const reachesEnd = placed.pos + olds.length === lines.length;
      lines = [...lines.slice(0, placed.pos), ...repl, ...lines.slice(placed.pos + olds.length)];
      if (reachesEnd) fin = !noBreakAfter(h.body);
      d += news - olds.length;
    } else {
      const pos = Math.min(h.a + d, lines.length);
      const repl = h.body.filter((e) => e.t === '+').map((e) => e.text);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos)];
      if (atEnd) fin = !noBreakAfter(h.body);
      d += repl.length;
    }
  }
  return joinFile({ br: m.br, lines, final: fin });
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** Apply one Update File section's chunks (SPEC.md section 8) to a file's text. */
function applyChunks(text: string, chunks: Chunk[], strict: boolean, path: string): string {
  const m = splitFile(text);
  let lines = m.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let at = -1;
      for (const tier of tiersOf(strict)) {
        for (let i = cursor; i < lines.length; i += 1) {
          if (eqTier(lines[i]!, ch.anchor, tier)) {
            at = i;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const olds = oldTexts(ch.body);
    if (olds.length === 0) {
      const repl = ch.body.filter((e) => e.t === '+').map((e) => e.text);
      const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos)];
      cursor = pos + repl.length;
      continue;
    }
    let done = false;
    for (const tier of tiersOf(strict)) {
      const occ = occurrences(lines, olds, tier, cursor).filter((i) => !ch.eof || i + olds.length === lines.length);
      if (occ.length === 0) continue;
      const pos = occ[0]!;
      const repl = writtenLines(lines, pos, ch.body, tier);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + olds.length)];
      cursor = pos + repl.length;
      done = true;
      break;
    }
    if (!done) throw new Fail('no-match', path);
  }
  return joinFile({ br: m.br, lines, final: m.final });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified-diff section (SPEC.md section 6) while it is read. */
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

const newSection = (): Section => ({
  diffOld: null,
  diffNew: null,
  pairOld: null,
  pairNew: null,
  renameFrom: null,
  renameTo: null,
  isNew: false,
  isDeleted: false,
  hunks: [],
});

/** A `---`/`+++` path: up to the first tab, spaces removed, `/dev/null` kept, one `a/` or `b/` prefix removed. */
function headerPath(raw: string): string {
  const p = raw.split('\t')[0]!.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return p;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    if (sec.isNew || oldP === '/dev/null') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const flat: BodyLine[] = [];
      for (const h of sec.hunks) flat.push(...h.body);
      const texts = flat.filter((e) => e.t === '+').map((e) => e.text);
      let fin = true;
      for (let j = flat.length - 1; j >= 0; j -= 1) {
        if (flat[j]!.t === '+') {
          fin = !(j + 1 < flat.length && flat[j + 1]!.t === '\\');
          break;
        }
      }
      tree.now.set(p, texts.length === 0 ? '' : texts.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (sec.isDeleted || newP === '/dev/null') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const o = oldP!;
      const n = newP!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const after = applyHunks(before, sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(n, after);
      tree.moves.push([o, n]);
      return;
    }
    const p = (oldP ?? newP)!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

/** Read a unified diff (SPEC.md section 6) as one edit a section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  const endHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = i + 1 < lines.length ? lines[i + 1]! : '';
    if (hunk !== null) {
      const endsBody = line.startsWith('diff --git ') || (line.startsWith('--- ') && next.startsWith('+++ '));
      if (!endsBody && (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\')) {
        hunk.body.push(line === '' ? { t: ' ', text: '', empty: true } : { t: line[0]!, text: line.slice(1) });
        i += 1;
        continue;
      }
      endHunk();
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (next.startsWith('+++ ')) {
        if (cur === null || cur.hunks.length > 0 || cur.pairOld !== null) {
          cur = newSection();
          sections.push(cur);
        }
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(next.slice(4));
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i += 1;
  }
  endHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7) as an edit. */
function srBlockEdit(path: string, olds: string[], news: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (olds.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, news.length === 0 ? '' : `${news.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const m = splitFile(before);
    let placed: { tier: number; pos: number } | null = null;
    for (const tier of tiersOf(strict)) {
      const occ = occurrences(m.lines, olds, tier, 0);
      if (occ.length === 0) continue;
      if (occ.length > 1) throw new Fail('ambiguous', path);
      placed = { tier, pos: occ[0]! };
      break;
    }
    if (placed === null) throw new Fail('no-match', path);
    const body: BodyLine[] = [
      ...olds.map((t) => ({ t: '-', text: t })),
      ...news.map((t) => ({ t: '+', text: t })),
    ];
    const repl = writtenLines(m.lines, placed.pos, body, placed.tier);
    const lines = [...m.lines.slice(0, placed.pos), ...repl, ...m.lines.slice(placed.pos + olds.length)];
    tree.now.set(path, joinFile({ br: m.br, lines, final: m.final }));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7), one edit a block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let j = searchLine + 1;
    const olds: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      olds.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    j += 1;
    const news: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      news.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    prevEnd = j;
    prevPath = path;
    i = j + 1;
    edits.push(srBlockEdit(path, olds, news, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One V4A section (SPEC.md section 8) while it is read. */
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  addLines: { text: string; raw: boolean }[];
  moveTo: string | null;
  chunks: Chunk[];
  started: boolean;
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const texts = sec.addLines.map((l) => l.text);
      tree.now.set(p, texts.length === 0 ? '' : `${texts.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const n = sec.moveTo;
    if (n !== null && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (n !== null && tree.get(n) !== null) throw new Fail('exists', n);
    const after = applyChunks(before, sec.chunks, strict, p);
    if (n !== null) {
      tree.now.set(p, null);
      tree.now.set(n, after);
      tree.moves.push([p, n]);
    } else {
      tree.now.set(p, after);
    }
  };
}

/** Read a V4A patch (SPEC.md section 8), one edit a section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let sec: VSection | null = null;
  let chunk: Chunk | null = null;
  const closeChunk = (): void => {
    if (chunk !== null && sec !== null) sec.chunks.push(chunk);
    chunk = null;
  };
  const endSection = (): void => {
    if (sec === null) return;
    closeChunk();
    if (sec.kind === 'add') {
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1]!.raw) sec.addLines.pop();
    }
    if (sec.kind === 'upd' && sec.chunks.length > 0) {
      const body = sec.chunks[sec.chunks.length - 1]!.body;
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
    }
    if (sec.kind === 'upd' && sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    sections.push(sec);
    sec = null;
  };
  const afterHead = (line: string, head: string): string | null => (line.startsWith(head) ? line.slice(head.length).trim() : null);
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    let p: string | null;
    if ((p = afterHead(line, '*** Add File:')) !== null) {
      endSection();
      sec = { kind: 'add', path: p, line: i + 1, addLines: [], moveTo: null, chunks: [], started: false };
      continue;
    }
    if ((p = afterHead(line, '*** Delete File:')) !== null) {
      endSection();
      sec = { kind: 'del', path: p, line: i + 1, addLines: [], moveTo: null, chunks: [], started: false };
      continue;
    }
    if ((p = afterHead(line, '*** Update File:')) !== null) {
      endSection();
      sec = { kind: 'upd', path: p, line: i + 1, addLines: [], moveTo: null, chunks: [], started: false };
      continue;
    }
    if (sec === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'add') {
      if (line.startsWith('+')) sec.addLines.push({ text: line.slice(1), raw: false });
      else if (line === '') sec.addLines.push({ text: '', raw: true });
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (sec.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (line.startsWith('*** Move to:')) {
      if (sec.started || sec.moveTo !== null) throw new Exit2(`error: parse ${i + 1}`);
      sec.moveTo = line.slice('*** Move to:'.length).trim();
      sec.started = true;
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      closeChunk();
      sec.started = true;
      continue;
    }
    if (line.startsWith('@@')) {
      closeChunk();
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      sec.started = true;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
      chunk.body.push(line === '' ? { t: ' ', text: '', empty: true } : { t: line[0]!, text: line.slice(1), empty: line.trim() === '' });
      sec.started = true;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  endSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const [o, n] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.get(o);
    const wasN = tree.original(n);
    const nowN = tree.now.get(n);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null && nowN !== undefined) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      paired.add(o);
      paired.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
