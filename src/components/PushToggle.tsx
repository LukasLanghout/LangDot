"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { railItem, RailLabel } from "./RailItem";

function base64UrlToBytes(b64: string) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = "loading" | "unsupported" | "ios-install" | "denied" | "off" | "on";

/** Meldingen op dit apparaat aan/uit. Werkt in Chrome, Edge, Firefox; op iPhone pas na "Zet op beginscherm". */
export function PushToggle({ expanded = true }: { expanded?: boolean }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setState(ios && !standalone ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") return setState("denied");
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const sub = await reg.pushManager.getSubscription();
        setState(sub ? "on" : "off");
      } catch {
        setState("unsupported");
      }
    })();
  }, []);

  async function enable() {
    setBusy(true);
    setMsg(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const { publicKey } = await fetch("/api/push/key").then((r) => r.json());
      if (!publicKey) {
        setMsg("Meldingen zijn op de server nog niet ingesteld.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error();
      setState("on");
    } catch {
      setMsg("Aanzetten is niet gelukt.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    const r = await fetch("/api/push/test", { method: "POST" }).then((x) => x.json()).catch(() => null);
    setMsg(r?.ok ? "Testmelding verstuurd." : r?.error ?? "Testmelding mislukt.");
    setBusy(false);
  }

  if (state === "loading") return null;

  const on = state === "on";
  const label = on ? "Meldingen staan aan" : "Meldingen aanzetten";
  const unavailable = state === "denied" || state === "ios-install" || state === "unsupported";
  const note =
    state === "denied" ? "Geblokkeerd in je browserinstellingen."
    : state === "ios-install" ? "Op iPhone: Deel, dan Zet op beginscherm, en open LangDot daarvandaan."
    : state === "unsupported" ? "Deze browser ondersteunt geen meldingen."
    : null;

  return (
    <div>
      <button
        type="button"
        onClick={on ? disable : enable}
        disabled={busy || unavailable}
        title={note ?? label}
        aria-pressed={on}
        className={`${railItem} disabled:opacity-60 disabled:hover:bg-transparent`}
      >
        <Icon name={on ? "bell" : "bell-off"} size={18} className={`shrink-0 ${on ? "text-accent-soft" : ""}`} />
        <RailLabel expanded={expanded}>{label}</RailLabel>
      </button>
      {expanded && (note || msg || on) && (
        <div className="px-[11px] pb-1 text-[13px] text-faint">
          {note ?? msg}
          {on && !msg && (
            <button type="button" onClick={test} disabled={busy} className="underline underline-offset-4 hover:text-muted">Testmelding sturen</button>
          )}
        </div>
      )}
    </div>
  );
}
