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

// ---------- file lines (SPEC section 3) ----------

function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------- matching (SPEC section 5) ----------

function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O occurs in lines at one tier (occurrences may overlap). */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || lines.length - from < o.length) return out;
  const on = o.map((l) => normLine(l, tier));
  const fn = lines.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (fn[i + j] !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** A line of N: `ctx` is its index in O when it is a context line, else null. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines for a match at `pos`: context lines are written as the file's own matched lines;
 * at tier 2 every other non-blank line of N that starts with P (the leading spaces/tabs of O's first line)
 * has that P replaced by F (the leading spaces/tabs of the file's first matched line).
 */
function replacement(lines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = tier === 2 ? leadOf(lines[pos]!) : '';
  const p = tier === 2 ? leadOf(o[0]!) : '';
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx !== null) out.push(lines[pos + item.ctx]!);
    else if (tier === 2 && item.text !== '' && !/^[ \t]*$/.test(item.text) && item.text.startsWith(p)) out.push(f + item.text.slice(p.length));
    else out.push(item.text);
  }
  return out;
}

// ---------- unified diffs (SPEC section 6) ----------

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line, or null when it has no `+` line */
  plusNoEol: boolean | null;
}

interface USection {
  gitA: string | null;
  gitB: string | null;
  pair: { old: string | null; new: string | null } | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

type BodyLine = { kind: 'ctx' | 'del' | 'add' | 'bs'; text: string };

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEAD = /^diff --git a\/(\S+) b\/(\S+)/;

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path a `--- ` / `+++ ` header line names (null for /dev/null). */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

function buildHunk(a: number, body: BodyLine[]): Hunk {
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === 'del') o.push(b.text);
    else if (b.kind === 'add') n.push({ text: b.text, ctx: null });
  }
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'add') {
      noEol = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  let plusNoEol: boolean | null = null;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === 'add') {
      plusNoEol = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { a, o, n, noEol, plusNoEol };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunkBody: BodyLine[] | null = null;
  let hunkA = 0;
  const startSection = (gitA: string | null, gitB: string | null): void => {
    if (hunkBody !== null && cur !== null) cur.hunks.push(buildHunk(hunkA, hunkBody));
    hunkBody = null;
    cur = { gitA, gitB, pair: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(cur);
  };
  const startHunk = (a: number): void => {
    if (hunkBody !== null && cur !== null) cur.hunks.push(buildHunk(hunkA, hunkBody));
    hunkBody = [];
    hunkA = a;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunkBody !== null) {
      if (line.startsWith('diff --git ')) {
        const m = GIT_HEAD.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(m[1]!, m[2]!);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null, null);
        cur!.pair = { old: headerPath(line), new: headerPath(lines[i + 1]!) };
        i += 2;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunkBody.push(
          line === ''
            ? { kind: 'ctx', text: '' }
            : line.startsWith(' ')
              ? { kind: 'ctx', text: line.slice(1) }
              : line.startsWith('-')
                ? { kind: 'del', text: line.slice(1) }
                : line.startsWith('+')
                  ? { kind: 'add', text: line.slice(1) }
                  : { kind: 'bs', text: '' },
        );
        i += 1;
        continue;
      }
      cur!.hunks.push(buildHunk(hunkA, hunkBody));
      hunkBody = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = GIT_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur === null || cur.pair !== null || cur.hunks.length > 0) startSection(null, null);
        cur!.pair = { old: headerPath(line), new: headerPath(lines[i + 1]!) };
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      startHunk(Number(m[1]));
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  if (hunkBody !== null && cur !== null) cur.hunks.push(buildHunk(hunkA, hunkBody));
  return sections;
}

function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const split = splitFile(text);
  const { lines, br } = split;
  let final = split.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const ins = h.n.map((x) => x.text);
      lines.splice(at, 0, ...ins);
      if (atEnd) final = !h.noEol;
      d += h.n.length;
    } else {
      const found = firstTier(lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + h.o.length === lines.length;
      const repl = replacement(lines, best, h.o, h.n, found.tier);
      lines.splice(best, h.o.length, ...repl);
      if (atEnd) final = !h.noEol;
      d += h.n.length - h.o.length;
    }
  }
  return joinFile(lines, br, final);
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldPath = sec.pair !== null ? sec.pair.old : (sec.renameFrom ?? sec.gitA);
    const newPath = sec.pair !== null ? sec.pair.new : (sec.renameTo ?? sec.gitB);
    if (oldPath === null || sec.newFile) {
      const target = newPath ?? '';
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const added: string[] = [];
        let plusNoEol: boolean | null = null;
        for (const h of sec.hunks) {
          for (const x of h.n) if (x.ctx === null) added.push(x.text);
          if (h.plusNoEol !== null) plusNoEol = h.plusNoEol;
        }
        tree.now.set(target, added.length === 0 ? '' : added.join('\n') + (plusNoEol === true ? '' : '\n'));
      };
    }
    if (newPath === null || sec.delFile) {
      const target = oldPath;
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      };
    }
    if (oldPath !== newPath) {
      return (tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        tree.now.set(newPath, applyUnifiedHunks(before, sec.hunks, strict, oldPath));
        tree.now.set(oldPath, null);
        moves.push([oldPath, newPath]);
      };
    }
    return (tree: Tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, applyUnifiedHunks(before, sec.hunks, strict, oldPath));
    };
  });
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const at = path;
    edits.push((tree: Tree) => {
      if (!safe(at)) throw new Fail('unsafe', at);
      if (oldLines.length === 0) {
        if (tree.get(at) !== null) throw new Fail('exists', at);
        tree.now.set(at, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(at);
      if (before === null) throw new Fail('missing', at);
      const split = splitFile(before);
      const found = firstTier(split.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', at);
      if (found.pos.length > 1) throw new Fail('ambiguous', at);
      const pos = found.pos[0]!;
      const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      const repl = replacement(split.lines, pos, oldLines, n, found.tier);
      split.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(at, joinFile(split.lines, split.br, split.final));
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC section 8) ----------

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const split = splitFile(before);
    const lines = split.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = firstTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = ch.n.map((x) => x.text);
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else if (ch.eof) {
        const tiers = strict ? [0] : [0, 1, 2];
        let hit: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const pos = occurrencesAt(lines, ch.o, t, cursor).filter((p) => p + ch.o.length === lines.length);
          if (pos.length > 0) {
            hit = { tier: t, pos: pos[0]! };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', path);
        const repl = replacement(lines, hit.pos, ch.o, ch.n, hit.tier);
        lines.splice(hit.pos, ch.o.length, ...repl);
        cursor = hit.pos + repl.length;
      } else {
        const found = firstTier(lines, ch.o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.pos[0]!;
        const repl = replacement(lines, pos, ch.o, ch.n, found.tier);
        lines.splice(pos, ch.o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = joinFile(lines, split.br, split.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ')) {
      const adding = line.startsWith('*** Add File: ');
      const path = line.slice(adding ? '*** Add File: '.length : '*** Delete File: '.length).trim();
      const start = i;
      i += 1;
      const raw: string[] = [];
      while (i < last && !isStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      if (adding) {
        const body: string[] = [];
        for (let k = 0; k < raw.length; k += 1) {
          const l = raw[k]!;
          if (l.startsWith('+')) body.push(l.slice(1));
          else if (l === '') body.push('');
          else throw new Exit2(`error: parse ${start + 2 + k}`);
        }
        edits.push((tree: Tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, body.length === 0 ? '' : body.join('\n') + '\n');
        });
      } else {
        for (let k = 0; k < raw.length; k += 1) {
          if (!blank(raw[k]!)) throw new Exit2(`error: parse ${start + 2 + k}`);
        }
        edits.push((tree: Tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      }
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const start = i;
      i += 1;
      const raw: string[] = [];
      while (i < last && !isStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; body: BodyLine[] } | null = null;
      const close = (eof: boolean): void => {
        if (cur === null) return;
        const o: string[] = [];
        const n: NewLine[] = [];
        for (const b of cur.body) {
          if (b.kind === 'ctx') {
            n.push({ text: b.text, ctx: o.length });
            o.push(b.text);
          } else if (b.kind === 'del') o.push(b.text);
          else if (b.kind === 'add') n.push({ text: b.text, ctx: null });
        }
        chunks.push({ anchor: cur.anchor, o, n, eof });
        cur = null;
      };
      for (; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${start + 2 + k}`);
          close(true);
          continue;
        }
        if (l.startsWith('@@')) {
          close(false);
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, body: [] };
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) {
              if (blank(l)) continue;
              throw new Exit2(`error: parse ${start + 2 + k}`);
            }
            cur = { anchor: null, body: [] };
          }
          cur.body.push(
            l === ''
              ? { kind: 'ctx', text: '' }
              : l.startsWith(' ')
                ? { kind: 'ctx', text: l.slice(1) }
                : l.startsWith('-')
                  ? { kind: 'del', text: l.slice(1) }
                  : { kind: 'add', text: l.slice(1) },
          );
          continue;
        }
        throw new Exit2(`error: parse ${start + 2 + k}`);
      }
      close(false);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
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
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [oldP, newP] of moves) {
    const a = changed.get(oldP);
    const b = changed.get(newP);
    if (a !== undefined && b !== undefined && a.was !== null && a.now === null && b.was === null && b.now !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
