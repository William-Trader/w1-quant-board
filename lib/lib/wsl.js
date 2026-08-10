// lib/wsl.js — WSL 策略表达式语言：递归下降解析器 + 求值器（无 eval）
// 表达式语法: 算术 + 比较 + and/or/not + 函数调用 + 变量（含 {var}_{tf} 跨周期简写）
'use strict';

// ---------- Tokenizer ----------
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const isId = c => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(' || c === ')' || c === ',' || c === '+' || c === '-' || c === '*' || c === '/') { tokens.push({ t: c }); i++; continue; }
    if (c === '>') { if (src[i + 1] === '=') { tokens.push({ t: '>=' }); i += 2; } else { tokens.push({ t: '>' }); i++; } continue; }
    if (c === '<') { if (src[i + 1] === '=') { tokens.push({ t: '<=' }); i += 2; } else { tokens.push({ t: '<' }); i++; } continue; }
    if (c === '=' && src[i + 1] === '=') { tokens.push({ t: '==' }); i += 2; continue; }
    if (c === '!' && src[i + 1] === '=') { tokens.push({ t: '!=' }); i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; let j = i + 1, s = '';
      while (j < src.length && src[j] !== q) { s += src[j]; j++; }
      if (j >= src.length) throw new Error('wsl: 未闭合字符串 "' + s.slice(0, 16) + '..."');
      tokens.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] || ''))) {
      let j = i, dots = 0;
      while (j < src.length && /[\d.]/.test(src[j])) { if (src[j] === '.') dots++; if (dots > 1) throw new Error('wsl: 非法数字 "' + src.slice(i, j + 1) + '"'); j++; }
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (isId(c)) {
      let j = i; while (j < src.length && isId(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    throw new Error(`wsl: 无法识别的字符 "${c}" 在第 ${i} 位`);
  }
  return tokens;
}

// ---------- Parser (递归下降) ----------
// expr = or_expr ; or_expr = and_expr { or and_expr } ; and_expr = not_expr { and not_expr }
// not_expr = [not] comparison ; comparison = arith { (>=|>|<=|<|==|!=) arith }
// arith = term { (+|-) term } ; term = factor { (*|/) factor } ; factor = num|str|id|id(...)|(expr)|-factor
function parse(src) {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isOp = (t, val) => t && t.t === val;
  function parseOr() {
    let left = parseAnd();
    while (peek() && (peek().t === 'id' && ['or', 'OR', 'Or'].includes(peek().v))) { next(); const right = parseAnd(); left = { type: 'binop', op: 'or', l: left, r: right }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek() && (peek().t === 'id' && ['and', 'AND', 'And'].includes(peek().v))) { next(); const right = parseNot(); left = { type: 'binop', op: 'and', l: left, r: right }; }
    return left;
  }
  function parseNot() {
    if (peek() && peek().t === 'id' && ['not', 'NOT', 'Not'].includes(peek().v)) { next(); return { type: 'unop', op: 'not', e: parseNot() }; }
    return parseComparison();
  }
  function parseComparison() {
    let left = parseArith();
    while (peek() && ['>=', '>', '<=', '<', '==', '!='].includes(peek().t)) { const op = next().t; const right = parseArith(); left = { type: 'binop', op, l: left, r: right }; }
    return left;
  }
  function parseArith() {
    let left = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) { const op = next().t; const right = parseTerm(); left = { type: 'binop', op, l: left, r: right }; }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    while (peek() && (peek().t === '*' || peek().t === '/')) { const op = next().t; const right = parseFactor(); left = { type: 'binop', op, l: left, r: right }; }
    return left;
  }
  function parseFactor() {
    const t = peek();
    if (!t) throw new Error('wsl: 表达式意外结束');
    if (t.t === 'num') { next(); return { type: 'num', v: t.v }; }
    if (t.t === 'str') { next(); return { type: 'str', v: t.v }; }
    if (t.t === '(') { next(); const e = parseOr(); if (!isOp(next(), ')')) throw new Error('wsl: 缺少右括号'); return e; }
    if (t.t === '-') { next(); return { type: 'unop', op: '-', e: parseFactor() }; }
    if (t.t === 'id') {
      const name = next().v;
      if (isOp(peek(), '(')) {
        next();
        const args = [];
        if (!isOp(peek(), ')')) {
          args.push(parseOr());
          while (isOp(peek(), ',')) { next(); args.push(parseOr()); }
        }
        if (!isOp(next(), ')')) throw new Error('wsl: 函数调用缺少右括号');
        return { type: 'call', name, args };
      }
      return { type: 'var', name };
    }
    throw new Error(`wsl: 意外的 token ${t.t}`);
  }
  const ast = parseOr();
  if (pos < toks.length) throw new Error('wsl: 表达式末尾有多余内容');
  return ast;
}

// ---------- 求值器 ----------
// ctx: { vars: {close:[],high:[],low:[],volume:[]...当前tf}, tfs: {'1d': {bars, emaCache...}}, funding_z30, lsr_z30, fgi, regime, side, fn: {...} }
function evaluate(ast, ctx, i) {
  switch (ast.type) {
    case 'num': return ast.v;
    case 'str': return ast.v;
    case 'unop':
      if (ast.op === 'not') return !evaluate(ast.e, ctx, i);
      if (ast.op === '-') return -evaluate(ast.e, ctx, i);
      break;
    case 'binop': {
      const l = evaluate(ast.l, ctx, i), r = evaluate(ast.r, ctx, i);
      switch (ast.op) {
        case '+': return l + r; case '-': return l - r;
        case '*': return l * r; case '/': return r === 0 ? NaN : l / r;
        case '>': return l > r; case '>=': return l >= r;
        case '<': return l < r; case '<=': return l <= r;
        case '==': return l == r; case '!=': return l != r;
        case 'and': return !!(l && r); case 'or': return !!(l || r);
      }
      break;
    }
    case 'var': {
      // 先尝试完整变量名（如 lsr_delta_4h / funding_z30），避免被跨周期简写误拆
      const v = ctx.getVar(ast.name, i);
      if (v !== undefined && !Number.isNaN(v)) return v;
      // {name}_{tf} 跨周期简写（如 close_1d / ema 序列）
      const m = /^(.+)_(1d|4h|1h|15m|8h)$/.exec(ast.name);
      if (m) {
        const tfv = ctx.getTfVar(m[1], m[2], i);
        if (tfv !== undefined && !Number.isNaN(tfv)) return tfv;
      }
      return v;
    }
    case 'call': {
      const fn = ctx.fn[ast.name];
      if (!fn) throw new Error(`wsl: 未知函数 ${ast.name}`);
      return fn(ctx, ast.args, i);
    }
  }
  return NaN;
}

module.exports = { parse, evaluate, tokenize };
