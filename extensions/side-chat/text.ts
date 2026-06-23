import { MAX_TOOL_ARG_PREVIEW } from "./constants.ts";

export function oneLine(text: string, max = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1))}…`;
}

export function toolArgsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  try {
    return oneLine(JSON.stringify(args), MAX_TOOL_ARG_PREVIEW);
  } catch {
    return "(unserializable args)";
  }
}
