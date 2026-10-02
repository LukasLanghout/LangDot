// Draait één keer bij het opstarten van de server: controleer dat GONKA_MODEL bestaat.
// Bewust NIET afwachten: een trage provider mag een koude start niet vertragen. verifyModels logt zelf.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  void import("./lib/llm").then(({ verifyModels }) => verifyModels()).catch(() => {});
}
