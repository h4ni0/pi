import {
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import { SIDE_TOOLS } from "./constants.ts";
import type { SideChatSnapshot } from "./types.ts";

export async function createSideSession(
  snapshot: SideChatSnapshot,
): Promise<AgentSession> {
  const { session } = await createAgentSession({
    cwd: snapshot.cwd,
    agentDir: getAgentDir(),
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    modelRegistry: snapshot.modelRegistry,
    resourceLoader: createStaticResourceLoader(
      createSideSystemPrompt(snapshot.systemPrompt),
    ),
    sessionManager: SessionManager.inMemory(snapshot.cwd),
    tools: SIDE_TOOLS,
  });

  session.state.messages = [...snapshot.inheritedMessages];
  return session;
}

function createSideSystemPrompt(baseSystemPrompt: string): string {
  return [
    "You are Pi's /btw side-chat agent.",
    "This temporary side conversation is not saved to or injected into the main conversation history.",
    "Answer clearly and concisely from the inherited main conversation context.",
    "Use only read-only inspection tools. Never modify files or steer the main session.",
    "If the inherited context is insufficient, say what is missing instead of guessing.",
    "",
    "<main_system_prompt>",
    baseSystemPrompt,
    "</main_system_prompt>",
  ].join("\n");
}

function createStaticResourceLoader(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
