// Safe arithmetic formula evaluator with named variable references.
//
// Supports Excel-like expressions over named fields (no cell coordinates):
//   = cash * 1.1 + nonNpCash - payout
//   = max(troughCash, 0) * spotRate
// Grammar (recursive descent, no eval / Function):
//   expr    := term (('+' | '-') term)*
//   term    := factor (('*' | '/' | '%') factor)*
//   factor  := ('+' | '-') factor | power
//   power   := primary ('^' factor)?
//   primary := number | ident ['(' args ')'] | '(' expr ')'
//
// Identifiers resolve against the scope; an identifier followed by '(' is a
// function call. Unknown identifiers / functions raise an error.

export type Scope = Record<string, number>;

type Token =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  abs:   a => Math.abs(a[0]),
  min:   a => Math.min(...a),
  max:   a => Math.max(...a),
  round: a => (a.length > 1 ? Number(a[0].toFixed(a[1])) : Math.round(a[0])),
  sqrt:  a => Math.sqrt(a[0]),
  pow:   a => Math.pow(a[0], a[1]),
  floor: a => Math.floor(a[0]),
  ceil:  a => Math.ceil(a[0]),
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c >= '0' && c <= '9' || (c === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
      let j = i + 1;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      const num = Number(s.slice(i, j));
      if (Number.isNaN(num)) throw new Error(`Invalid number "${s.slice(i, j)}"`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      tokens.push({ t: 'id', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '(') { tokens.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { tokens.push({ t: 'comma' }); i++; continue; }
    if ('+-*/%^'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly scope: Scope) {}

  parse(): number {
    const v = this.expr();
    if (this.pos < this.tokens.length) throw new Error('Unexpected trailing input');
    return v;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }

  private expr(): number {
    let v = this.term();
    let tok = this.peek();
    while (tok && tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
      this.pos++;
      const rhs = this.term();
      v = tok.v === '+' ? v + rhs : v - rhs;
      tok = this.peek();
    }
    return v;
  }

  private term(): number {
    let v = this.factor();
    let tok = this.peek();
    while (tok && tok.t === 'op' && (tok.v === '*' || tok.v === '/' || tok.v === '%')) {
      this.pos++;
      const rhs = this.factor();
      v = tok.v === '*' ? v * rhs : tok.v === '/' ? v / rhs : v % rhs;
      tok = this.peek();
    }
    return v;
  }

  private factor(): number {
    const tok = this.peek();
    if (tok && tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
      this.pos++;
      const v = this.factor();
      return tok.v === '-' ? -v : v;
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    const tok = this.peek();
    if (tok && tok.t === 'op' && tok.v === '^') {
      this.pos++;
      const exp = this.factor();
      return Math.pow(base, exp);
    }
    return base;
  }

  private primary(): number {
    const tok = this.peek();
    if (!tok) throw new Error('Unexpected end of formula');
    if (tok.t === 'num') { this.pos++; return tok.v; }
    if (tok.t === 'lp') {
      this.pos++;
      const v = this.expr();
      if (this.peek()?.t !== 'rp') throw new Error('Missing closing parenthesis');
      this.pos++;
      return v;
    }
    if (tok.t === 'id') {
      this.pos++;
      if (this.peek()?.t === 'lp') {
        this.pos++;
        const args: number[] = [];
        if (this.peek()?.t !== 'rp') {
          args.push(this.expr());
          while (this.peek()?.t === 'comma') { this.pos++; args.push(this.expr()); }
        }
        if (this.peek()?.t !== 'rp') throw new Error('Missing closing parenthesis');
        this.pos++;
        const fn = FUNCTIONS[tok.v.toLowerCase()];
        if (!fn) throw new Error(`Unknown function "${tok.v}"`);
        return fn(args);
      }
      if (!(tok.v in this.scope)) throw new Error(`Unknown field "${tok.v}"`);
      return this.scope[tok.v];
    }
    throw new Error('Unexpected token');
  }
}

/**
 * Split a formula into its lexemes (identifiers, numbers, operators, parens,
 * commas) as strings. Whitespace is dropped. Used by the chip editor so each
 * variable/number can be shown and deleted as a whole token. Throws only on a
 * genuinely illegal character.
 */
export function lexFormula(expr: string): string[] {
  const s = expr.trim().replace(/^=/, '');
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || (c === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
      let j = i + 1;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      out.push(s.slice(i, j)); i = j; continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      out.push(s.slice(i, j)); i = j; continue;
    }
    if ('+-*/%^(),'.includes(c)) { out.push(c); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

/** Evaluate an expression against a scope. Throws on any parse/reference error. */
export function evalFormula(expr: string, scope: Scope): number {
  const cleaned = expr.trim().replace(/^=/, '').trim();
  if (cleaned === '') throw new Error('Empty formula');
  const value = new Parser(tokenize(cleaned), scope).parse();
  if (!Number.isFinite(value)) throw new Error('Formula did not evaluate to a finite number');
  return value;
}

export interface FormulaEvalResult {
  value: number;
  error?: string;
}

/** Non-throwing evaluation. Returns { value, error }. */
export function safeEval(expr: string, scope: Scope): FormulaEvalResult {
  try {
    return { value: evalFormula(expr, scope) };
  } catch (e) {
    return { value: NaN, error: e instanceof Error ? e.message : 'Invalid formula' };
  }
}
