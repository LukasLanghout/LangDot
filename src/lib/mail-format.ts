// Mailopmaak. Het model schrijft Markdown (koppen, **vet**, [tekst](url), lijsten); wij maken er een nette
// HTML-mail van (met platte-tekstversie erbij). Schrijft het model toch HTML, dan zetten we dat eerst om naar Markdown.
// Alles wordt ge-escaped; er komt nooit HTML van het model in de verstuurde mail.

const HTML_HINT = /<\/?(html|body|h[1-6]|p|div|span|a|ul|ol|li|br|hr|strong|b|em|table|tr|td)\b[^>]*>/i;

export function looksLikeHtml(text: string) {
  return HTML_HINT.test(text);
}

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** HTML van het model → leesbare Markdown (links, koppen, lijsten blijven behouden). */
export function htmlToMarkdown(html: string) {
  let t = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = String(label).replace(/<[^>]+>/g, "").trim();
      return /^(https?:|mailto:)/i.test(href) ? `[${text || href}](${href})` : text;
    })
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h[3-6][^>]*>([\s\S]*?)<\/h[3-6]>/gi, "\n\n### $1\n\n")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<hr[^>]*>/gi, "\n\n---\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|ul|ol|table)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  t = decodeEntities(t).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/** Zorgt dat een mailbody Markdown/platte tekst is, ook als het model HTML schreef. */
export function normalizeMailBody(body: string) {
  return looksLikeHtml(body) ? htmlToMarkdown(body) : body.trim();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string) {
  // Eerst ruwe URL's en Markdown-links uit de tekst halen (op de ongeëscapete tekst), dan de rest escapen.
  const parts: string[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const emphasis = (s: string) =>
    esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  while ((m = re.exec(text))) {
    parts.push(emphasis(text.slice(last, m.index)));
    const href = m[2] ?? m[3];
    const label = m[1] ?? href;
    parts.push(`<a href="${esc(href)}" style="color:#2563eb;text-decoration:underline">${emphasis(label)}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(emphasis(text.slice(last)));
  return parts.join("");
}

/** Markdown (koppen, vet, links, lijsten, scheidingslijnen) → veilige HTML met inline stijlen. */
export function markdownToHtml(md: string) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p style="margin:0 0 12px;line-height:1.5">${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul style="margin:0 0 12px;padding-left:22px;line-height:1.5">${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const level = Math.min(h[1].length, 3);
      const size = level === 1 ? 22 : level === 2 ? 18 : 16;
      out.push(`<h${level} style="margin:18px 0 6px;font-size:${size}px;line-height:1.3;color:#111">${inline(h[2])}</h${level}>`);
    } else if (/^\s*([-*•]|\d+\.)\s+/.test(line) && !/^-{3,}$/.test(line.trim())) {
      flushPara();
      list.push(line.replace(/^\s*([-*•]|\d+\.)\s+/, ""));
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushPara(); flushList();
      out.push('<hr style="border:0;border-top:1px solid #e5e5e5;margin:16px 0">');
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;max-width:720px;margin:0 auto;padding:16px">${out.join("")}</body></html>`;
}
