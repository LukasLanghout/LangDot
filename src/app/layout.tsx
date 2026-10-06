import type { Metadata, Viewport } from "next";
import { Inter, Newsreader } from "next/font/google";
import "./globals.css";

// Sans voor de interface, serif met karakter voor koppen en de antwoorden van de dot. font-display: swap, geen layout shift.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap", style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "LangDot",
  description: "Je persoonlijke, altijd-aanwezige agent.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF9F5" },
    { media: "(prefers-color-scheme: dark)", color: "#1A1918" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Zet het gekozen thema vóór de eerste verf, zodat er geen flits is. Zonder keuze volgt de app het systeem.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('langdot-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl" className={`${inter.variable} ${newsreader.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
