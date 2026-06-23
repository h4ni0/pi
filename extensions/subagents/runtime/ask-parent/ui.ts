import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function askUserQuestions(
  params: {
    message: string;
    question?: string;
    questions?: string[];
    options?: string[];
    recommendation?: string;
    title?: string;
  },
  ctx: ExtensionContext,
): Promise<string> {
  if (!ctx.hasUI) return "No interactive user UI is available.";
  const questions = params.questions?.length
    ? params.questions
    : params.question
      ? [params.question]
      : [];
  const title =
    params.title || (questions.length === 1 ? "Question for user" : "Questions for user");
  if (questions.length <= 1 && params.options?.length) {
    const choices = [...params.options, "Other / custom answer"];
    const choice = await ctx.ui.select(title, choices);
    if (!choice) return "No answer was provided.";
    if (choice !== "Other / custom answer") return choice;
  }
  const prompt = [
    params.message,
    questions.length ? "" : undefined,
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    params.recommendation ? `\nRecommendation: ${params.recommendation}` : undefined,
    params.options?.length ? `Options: ${params.options.join(" | ")}` : undefined,
    "",
    "Answer:",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  const answer = await ctx.ui.editor(title, prompt);
  return answer?.trim() || "No answer was provided.";
}
