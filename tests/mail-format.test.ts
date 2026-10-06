import { describe, expect, it } from "vitest";
import { htmlToMarkdown, looksLikeHtml, markdownToHtml, normalizeMailBody } from "@/lib/mail-format";
import { buildMime } from "@/lib/connectors/gmail";
import { validateEmailPayload } from "@/lib/actions";

// Zo schreef het model de mail (gezien in de echte inbox): HTML als platte tekst verstuurd.
const MODEL_HTML = `<html><body style="font-family: Arial">
<h1 style="color:#1a1a1a">🤖 Tech Nieuws - Dinsdag 6 Oktober 2026</h1>
<hr style="border: 1px solid #eee">
<h2>1. Reflection AI onthult Beam</h2>
<p><strong>📅 5 oktober 2026</strong></p>
<p>Reflection AI heeft Beam gelanceerd &amp; deelt de weights.</p>
<p><strong>🔗 Bron:</strong> <a href="https://www.marktechpost.com/2026/10/05/beam">MarkTechPost</a> | <a href="https://thenextweb.com/x">The Next Web</a></p>
</body></html>`;

describe("mailopmaak", () => {
  it("HTML van het model wordt Markdown met behoud van koppen en bronlinks", () => {
    expect(looksLikeHtml(MODEL_HTML)).toBe(true);
    const md = htmlToMarkdown(MODEL_HTML);
    expect(md).toContain("# 🤖 Tech Nieuws - Dinsdag 6 Oktober 2026");
    expect(md).toContain("## 1. Reflection AI onthult Beam");
    expect(md).toContain("[MarkTechPost](https://www.marktechpost.com/2026/10/05/beam)");
    expect(md).toContain("beam gelanceerd & deelt".replace("beam", "Beam"));
    expect(md).not.toMatch(/<\/?(p|h1|h2|a|strong|body)\b/);
  });

  it("Markdown wordt nette HTML met klikbare bronnen", () => {
    const html = markdownToHtml("# Titel\n\n**Vet** en [bron](https://example.com/a?b=1&c=2)\n\n- een\n- twee\n\n---\n\nLos: https://example.org/x.");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>Vet</strong>");
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain("<li>een</li>");
    expect(html).toContain("<hr");
    expect(html).toContain('<a href="https://example.org/x"');
  });

  it("HTML-injectie en gevaarlijke links komen niet in de mail", () => {
    const html = markdownToHtml('Hoi <script>alert(1)</script> [klik](javascript:alert(1)) <img src=x onerror=alert(2)>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
  });

  it("de goedkeuringskaart krijgt Markdown, niet de ruwe HTML", () => {
    const v = validateEmailPayload({ to: ["a@example.com"], subject: "x", body: MODEL_HTML });
    expect(v.ok && v.payload.body).toContain("## 1. Reflection AI onthult Beam");
    expect(normalizeMailBody("Gewone tekst met [link](https://a.nl)")).toBe("Gewone tekst met [link](https://a.nl)");
  });

  it("de verstuurde mail bevat tekst én HTML (multipart/alternative)", () => {
    const mime = buildMime({ to: ["a@example.com"], subject: "Tech", body: "# Hoi\n\n[bron](https://a.nl)" });
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
    const html = Buffer.from(mime.split("text/html")[1].split("\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(html).toContain("<h1");
    expect(html).toContain('href="https://a.nl"');
  });
});