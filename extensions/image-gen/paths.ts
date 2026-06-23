import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function getPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

function imageOutputDir(): string {
  return (
    process.env.PI_IMAGE_GEN_OUTPUT_DIR ||
    path.join(getPiAgentDir(), "generated_images")
  );
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "generated_image";
}

export async function saveGeneratedImage(
  toolCallId: string,
  b64Json: string,
): Promise<string> {
  const sessionPart = sanitizePathPart(new Date().toISOString().slice(0, 10));
  const fileName = `${sanitizePathPart(toolCallId)}.png`;
  const dir = path.join(imageOutputDir(), sessionPart);
  const filePath = path.join(dir, fileName);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, Buffer.from(b64Json.trim(), "base64"));
  return filePath;
}
