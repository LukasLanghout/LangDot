// Draait één keer bij het opstarten van de server: controleer dat GONKA_MODEL bestaat.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { verifyModels } = await import("./lib/llm");
  await verifyModels().catch(() => {
    /* verifyModels logt zelf een duidelijke fout */
  });
}
