const AGENT_SEGMENT = /^[a-z0-9_]+$/;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Codex-compatible canonical agent path parser (Pi intentionally excludes /morpheus). */
export function parseAgentPath(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("agent path must not be empty");
  if (!value.startsWith("/root"))
    throw new Error("absolute agent paths must start with `/root`");
  if (value === "/root") return value;
  if (!value.startsWith("/root/") || value.endsWith("/"))
    throw new Error("absolute agent path must be `/root` or a non-trailing descendant");
  for (const segment of value.slice(1).split("/").slice(1))
    validateAgentSegment(segment);
  return value;
}

export function validateAgentSegment(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("agent name must not be empty");
  if (value === "root" || value === "." || value === "..")
    throw new Error(`agent name \`${value}\` is reserved`);
  if (value.includes("/") || !AGENT_SEGMENT.test(value))
    throw new Error(
      "agent name must use only lowercase letters, digits, and underscores",
    );
  return value;
}

export function joinAgentPath(parent: string, segment: string): string {
  return `${parseAgentPath(parent)}/${validateAgentSegment(segment)}`;
}

export function resolveAgentReference(caller: string, reference: string): string {
  parseAgentPath(caller);
  assertStrictReferenceText(reference);
  if (reference.startsWith("/")) return parseAgentPath(reference);
  const segments = reference.split("/");
  for (const segment of segments) validateAgentSegment(segment);
  return parseAgentPath(`${caller}/${reference}`);
}

export function resolveAgentReferenceWithAliases(
  caller: string,
  reference: string,
  aliasToPath: Pick<ReadonlyMap<string, string>, "get">,
  canonicalPaths: Pick<ReadonlySet<string>, "has">,
): string {
  parseAgentPath(caller);
  assertStrictReferenceText(reference);
  const aliasPath = aliasToPath.get(reference);
  const usesPathSyntax = reference.startsWith("/") || reference.includes("/");
  let canonicalPath: string | undefined;
  try {
    const candidate = resolveAgentReference(caller, reference);
    if (canonicalPaths.has(candidate)) canonicalPath = candidate;
  } catch (error) {
    // Opaque Pi IDs may use characters that canonical path segments do not,
    // but slash-bearing references are always paths and must remain strict.
    if (!aliasPath || usesPathSyntax) throw error;
  }
  if (aliasPath && canonicalPath && aliasPath !== canonicalPath)
    throw new Error(`Ambiguous agent target '${reference}'; use a canonical path`);
  const resolved = canonicalPath ?? aliasPath;
  if (!resolved) throw new Error(`Unknown agent target '${reference}'`);
  return parseAgentPath(resolved);
}

function assertStrictReferenceText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("agent path must not be empty");
  if (value !== value.trim())
    throw new Error("agent references must not contain whitespace padding");
  if (value.endsWith("/"))
    throw new Error("agent references must not end with `/`");
  if (value === "." || value === "..")
    throw new Error(`agent reference \`${value}\` is reserved`);
}

export function isAgentPathWithin(path: string, prefix: string): boolean {
  const candidate = parseAgentPath(path);
  const base = parseAgentPath(prefix);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/** Locale-independent Unicode code-point order for canonical registry output. */
export function compareAgentPaths(left: string, right: string): number {
  parseAgentPath(left);
  parseAgentPath(right);
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

export function agentPathDepth(path: string): number {
  return parseAgentPath(path).split("/").length - 2;
}

export function validateSafeBasename(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    value === "." ||
    value === ".." ||
    !SAFE_BASENAME.test(value)
  )
    throw new Error(`${field} must be an opaque safe basename`);
  return value;
}
