import type { MetadataRoute } from "next";

// Maakt LangDot installeerbaar (beginscherm). Op iPhone/iPad werken push-meldingen alleen zo.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LangDot",
    short_name: "LangDot",
    description: "Je persoonlijke, altijd-aanwezige agent.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f0f14",
    theme_color: "#0f0f14",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
