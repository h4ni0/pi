export function isOpenAICodexProvider(provider: string | undefined): boolean {
  return (
    provider === "openai-codex" || /^openai-codex-\d+$/.test(provider || "")
  );
}
