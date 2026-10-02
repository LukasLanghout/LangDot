import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractText, looksLikeText } from "@/lib/documents/extract";
import { buildMime } from "@/lib/connectors/gmail";
import { approveAction, executePendingAction, validateEmailPayload } from "@/lib/actions";
import { gmailCreateDraft } from "@/lib/agent/mail-tools";
import { documentsBlock } from "@/lib/agent/prompts";
import { execDeps, mailDeps, memoryStore } from "./helpers";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("tekst uit bestanden halen", () => {
  it("tekst, markdown, csv, json en code", async () => {
    for (const [name, mime] of [["a.txt", "text/plain"], ["b.md", ""], ["c.csv", "text/csv"], ["d.json", "application/json"], ["e.ts", ""]]) {
      const r = await extractText(buf("Hallo wereld 123"), name, mime);
      expect(r.status).toBe("ready");
      expect(r.text).toContain("Hallo wereld");
    }
  });

  it("HTML zonder scripts en tags", async () => {
    const r = await extractText(buf("<html><script>alert(1)</script><p>Zichtbare tekst</p></html>"), "x.html", "text/html");
    expect(r.text).toContain("Zichtbare tekst");
    expect(r.text).not.toContain("alert");
  });

  it("Word (.docx)", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Stagerapport Lancyr</w:t></w:r></w:p></w:body></w:document>`);
    const r = await extractText(await zip.generateAsync({ type: "nodebuffer" }), "rapport.docx", "");
    expect(r.status).toBe("ready");
    expect(r.text).toContain("Stagerapport Lancyr");
  });

  it("Excel (.xlsx), alle bladen", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Naam", "Score"], ["Pavel", 8]]), "Team");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Budget", 1200]]), "Geld");
    const r = await extractText(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), "data.xlsx", "");
    expect(r.text).toContain("## Blad: Team");
    expect(r.text).toContain("Pavel,8");
    expect(r.text).toContain("## Blad: Geld");
  });

  it("PowerPoint (.pptx), dia's op volgorde", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", `<p:sld><a:t>Tweede dia</a:t></p:sld>`);
    zip.file("ppt/slides/slide1.xml", `<p:sld><a:t>Eerste</a:t><a:t>dia</a:t></p:sld>`);
    const r = await extractText(await zip.generateAsync({ type: "nodebuffer" }), "deck.pptx", "");
    expect(r.text.indexOf("Eerste dia")).toBeLessThan(r.text.indexOf("Tweede dia"));
  });

  it("OpenDocument (.odt) en RTF", async () => {
    const zip = new JSZip();
    zip.file("content.xml", `<office:document-content><text:p>Open tekst</text:p></office:document-content>`);
    expect((await extractText(await zip.generateAsync({ type: "nodebuffer" }), "x.odt", "")).text).toContain("Open tekst");
    expect((await extractText(buf("{\\rtf1\\ansi Hallo \\b vet\\b0 tekst\\par}"), "x.rtf", "")).text).toContain("Hallo");
  });

  it("onbekende binaire bestanden, audio en oude Office-formaten zijn 'niet leesbaar' met uitleg", async () => {
    const bin = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7) % 256));
    expect(looksLikeText(bin)).toBe(false);
    expect((await extractText(bin, "x.bin", "application/octet-stream")).status).toBe("unsupported");
    expect((await extractText(bin, "x.mp3", "audio/mpeg")).error).toMatch(/Audio/);
    expect((await extractText(bin, "x.doc", "")).error).toMatch(/docx/);
  });

  it("een kapot bestand geeft 'failed' in plaats van een crash", async () => {
    const r = await extractText(buf("dit is geen zip"), "kapot.docx", "");
    expect(r.status).toBe("failed");
  });
});

describe("mail met bijlagen", () => {
  it("bouwt multipart/mixed met base64-bijlage en veilige bestandsnaam", () => {
    const mime = buildMime(
      { to: ["jan@example.com"], subject: "CV", body: "Zie bijlage" },
      [{ name: "cv lukas é.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.4 test") }],
    );
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="langdot_/);
    expect(mime).toContain("Content-Disposition: attachment; filename*=UTF-8''cv%20lukas%20%C3%A9.pdf");
    expect(mime).toContain(Buffer.from("%PDF-1.4 test").toString("base64"));
  });

  it("alleen eigen documenten kunnen als bijlage mee", async () => {
    const store = memoryStore();
    const deps = {
      ...mailDeps(store),
      getDocuments: async (userId: string, ids: string[]) =>
        ids.filter((id) => id === "doc-van-mij" && userId === "user-1").map((id) => ({ id, name: "cv.pdf", mime: "application/pdf", size: 1000 })),
    };
    const ctx = { userId: "user-1", taskId: null, canCompose: false, createdActionIds: [] as string[] };
    await expect(gmailCreateDraft(deps, ctx, { to: ["jan@example.com"], subject: "a", body: "b", attachments: ["doc-van-iemand-anders"] }))
      .rejects.toThrow(/Onbekend document/);
    const ok = await gmailCreateDraft(deps, ctx, { to: ["jan@example.com"], subject: "a", body: "b", attachments: ["doc-van-mij"] });
    expect(ok.attachments).toEqual(["cv.pdf"]);
  });

  it("bijlagen worden pas bij versturen geladen, en alleen na goedkeuring", async () => {
    const store = memoryStore();
    const loaded: string[] = [];
    const sentFiles: number[] = [];
    const deps = {
      ...execDeps(store),
      loadAttachment: async (_u: string, id: string) => {
        loaded.push(id);
        return { name: "cv.pdf", mime: "application/pdf", data: Buffer.from("x") };
      },
      send: async (_t: string, _p: unknown, files: unknown[]) => {
        sentFiles.push(files.length);
        return "msg";
      },
    };
    const action = await store.create({
      userId: "user-1", taskId: null, type: "gmail_send",
      payload: { to: ["jan@example.com"], subject: "CV", body: "zie bijlage", attachments: [{ document_id: "d1", name: "cv.pdf", mime: "application/pdf", size: 1 }] },
    });
    expect((await executePendingAction(deps, "user-1", action.id)).ok).toBe(false);
    expect(loaded).toEqual([]);
    await approveAction(store, "user-1", action.id);
    expect((await executePendingAction(deps, "user-1", action.id)).ok).toBe(true);
    expect(loaded).toEqual(["d1"]);
    expect(sentFiles).toEqual([1]);
  });

  it("maximaal 5 bijlagen en 15 MB samen", () => {
    const att = (i: number, size = 1000) => ({ document_id: `d${i}`, name: `f${i}.pdf`, mime: "application/pdf", size });
    const base = { to: ["jan@example.com"], subject: "x", body: "y" };
    expect(validateEmailPayload({ ...base, attachments: [1, 2, 3, 4, 5, 6].map((i) => att(i)) }).ok).toBe(false);
    expect(validateEmailPayload({ ...base, attachments: [att(1, 16 * 1024 * 1024)] }).ok).toBe(false);
    expect(validateEmailPayload({ ...base, attachments: [att(1)] }).ok).toBe(true);
  });
});

describe("vastgezette documenten in de prompt", () => {
  it("staan erin (ingekort) en recente documenten worden met id genoemd", () => {
    const block = documentsBlock({
      documents: {
        pinned: [{ name: "Over mij.md", text: "Ik ben Lukas. Geen en-dashes gebruiken. " + "x".repeat(20_000) }],
        recent: [{ id: "doc-1", name: "cv.pdf", readable: true, chars: 1200 }],
      },
    });
    expect(block).toContain("Over mij.md");
    expect(block).toContain("Geen en-dashes gebruiken");
    expect(block).toContain("ingekort");
    expect(block).toContain("cv.pdf (id: doc-1");
    expect(block.length).toBeLessThan(18_000);
  });
});
