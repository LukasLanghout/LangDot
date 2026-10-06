// Veilige rekenmachine: recursive descent, geen eval. Het model mag nooit uit het hoofd rekenen.
// Ondersteunt + - * / % (rest) ^ (macht), haakjes, decimalen (punt of komma), x% (procent), pi, e en
// de functies sqrt, abs, round, floor, ceil, min, max (argumenten gescheiden met ; bv. max(3;4)).

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "id"; v: string };

function tokenize(src: string): Tok[] {
  const s = src.replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/[0-9.,]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.,]/.test(s[j])) j++;
      let raw = s.slice(i, j);
      // "1.234,56" (NL) of "1,234.56" (EN): de laatste scheider is de decimale; "3,5" is 3.5
      const lastComma = raw.lastIndexOf(",");
      const lastDot = raw.lastIndexOf(".");
      if (lastComma >= 0 && lastDot >= 0) {
        raw = lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
      } else if (lastComma >= 0) {
        raw = raw.replace(",", ".");
      }
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`Ongeldig getal: ${raw}`);
      out.push({ t: "num", v });
      i = j;
    } else if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      out.push({ t: "id", v: s.slice(i, j).toLowerCase() });
      i = j;
    } else if ("+-*/%^();".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
    } else {
      throw new Error(`Onverwacht teken: ${ch}`);
    }
  }
  return out;
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max,
};

export function calculate(expression: string): number {
  if (!expression || expression.length > 300) throw new Error("Expressie is leeg of te lang");
  const toks = tokenize(expression);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;

  function primary(): number {
    const tk = toks[pos++];
    if (!tk) throw new Error("Onvolledige expressie");
    if (tk.t === "num") {
      let v = tk.v;
      while (isOp("%") && (toks[pos + 1] === undefined || toks[pos + 1].t === "op")) { pos++; v /= 100; }
      return v;
    }
    if (tk.t === "id") {
      if (tk.v === "pi") return Math.PI;
      if (tk.v === "e") return Math.E;
      const fn = FUNCS[tk.v];
      if (!fn) throw new Error(`Onbekende functie: ${tk.v}`);
      if (!isOp("(")) throw new Error(`Haakjes ontbreken bij ${tk.v}`);
      pos++;
      const args: number[] = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(expr());
          if (!isOp(";")) break;
          pos++;
        }
      }
      if (!isOp(")")) throw new Error("Sluithaakje ontbreekt");
      pos++;
      return fn(...args);
    }
    if (tk.v === "(") {
      const v = expr();
      if (!isOp(")")) throw new Error("Sluithaakje ontbreekt");
      pos++;
      return v;
    }
    if (tk.v === "-") return -power();
    if (tk.v === "+") return power();
    throw new Error(`Onverwacht: ${tk.v}`);
  }

  function power(): number {
    const base = primary();
    if (isOp("^")) {
      pos++;
      return Math.pow(base, power());
    }
    return base;
  }

  function term(): number {
    let v = power();
    while (isOp("*") || isOp("/") || (isOp("%") && toks[pos + 1] !== undefined && toks[pos + 1].t !== "op")) {
      const op = (toks[pos++] as { v: string }).v;
      const r = power();
      if (op === "*") v *= r;
      else if (op === "/") {
        if (r === 0) throw new Error("Delen door nul");
        v /= r;
      } else {
        if (r === 0) throw new Error("Rest bij delen door nul");
        v %= r;
      }
    }
    return v;
  }

  function expr(): number {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[pos++] as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  const result = expr();
  if (pos < toks.length) throw new Error("Onverwacht einde van de expressie");
  if (!Number.isFinite(result)) throw new Error("Resultaat is geen eindig getal");
  return Math.round(result * 1e10) / 1e10;
}
