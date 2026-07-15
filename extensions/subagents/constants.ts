export const EXTENSION_KEY = "subagents";
export const SUBAGENTS_GLOBAL_STATUS_KEY = "__pi_subagents_status_v1";
export const COLLABORATION_GUARD = Symbol.for(
  "pi.subagents.collaboration-manager.v2",
);
export const COMPLETION_MESSAGE_TYPE = "subagent-v2-completion";
export const LEGACY_COMPLETION_MESSAGE_TYPE = "subagents.completion";
export const STATE_ENTRY_TYPE = "subagents-v2-state";
export const NOTICE_MESSAGE_TYPE = "subagents.notice";
export const QUESTION_MESSAGE_TYPE = "subagents.question";
export const ASK_PARENT_EXCHANGE_MESSAGE_TYPE = "subagents.ask_parent_exchange";
export const ASK_PARENT_ESCALATE_OPEN = "<ask_parent_escalate>";
export const ASK_PARENT_ESCALATE_CLOSE = "</ask_parent_escalate>";
export const DEFAULT_RETURN_MAX_BYTES = 50_000;
export const DEFAULT_COMPLETION_MESSAGE_MAX_BYTES = 16 * 1024;
export const HARD_COMPLETION_MESSAGE_MAX_BYTES = 24 * 1024;
export const DEFAULT_COMPLETION_BURST_MAX_BYTES = 48 * 1024;
export const DEFAULT_COMPLETION_OUTBOX_LIMIT = 32;
export const BROKER_FRAME_MAX_BYTES = 256 * 1024;
export const BROKER_REPORT_OUTPUT_MAX_BYTES = 24 * 1024;
export const BROKER_MAILBOX_MAX_ITEMS_PER_TARGET = 64;
export const BROKER_MAILBOX_MAX_BYTES_PER_TARGET = 128 * 1024;
export const BROKER_MAILBOX_MAX_BYTES_PER_TREE = 1024 * 1024;
export const BROKER_AUTH_DEADLINE_MS = 2_000;
export const BROKER_SHUTDOWN_TIMEOUT_MS = 2_000;
export const BROKER_DISPATCH_DRAIN_TIMEOUT_MS = 2_000;
export const BROKER_MAX_ACCEPTED_CONNECTIONS = 256;
export const BROKER_MAX_OUTSTANDING_REQUESTS = 32;
export const BROKER_MAX_REQUESTS_PER_WINDOW = 128;
export const BROKER_RATE_WINDOW_MS = 1_000;
export const BROKER_MAX_OUTBOUND_QUEUE_FRAMES = 64;
export const BROKER_MAX_OUTBOUND_QUEUE_BYTES = 1024 * 1024;
// Pi RPC lifecycle records such as agent_end include the complete turn history and
// routinely exceed the broker's intentionally small control-frame limit.
export const CHILD_RPC_RECORD_MAX_BYTES = 16 * 1024 * 1024;
export const EVENT_LOG_LIMIT = 240;
/** Bounded per-record settled-turn replay/history guard. */
export const SETTLED_TURN_ID_LIMIT = 256;
export const STDERR_TAIL_MAX_BYTES = 64 * 1024;
export const LAST_TASK_MESSAGE_MAX_CHARS = 240;
export const ASK_PARENT_REQUEST_FRAME_MAX_BYTES = 32 * 1024;
export const ASK_PARENT_ANSWER_MAX_BYTES = 16 * 1024;
export const ASK_PARENT_RATE_WINDOW_MS = 60_000;
export const ASK_PARENT_PER_CHILD_REQUESTS_PER_WINDOW = 8;
export const ASK_PARENT_GLOBAL_REQUESTS_PER_WINDOW = 32;
export const ASK_PARENT_PER_CHILD_MODEL_CALLS_PER_WINDOW = 4;
export const ASK_PARENT_GLOBAL_MODEL_CALLS_PER_WINDOW = 16;
export const ASK_PARENT_MAX_QUEUED = 16;
export const ASK_PARENT_MAX_CONCURRENT = 2;
export const ASK_PARENT_DELIVERY_ATTEMPTS = 2;
export const ASK_PARENT_DELIVERY_RETRY_MS = 25;
export const ASK_PARENT_CLAIM_CACHE_LIMIT = 512;
export const DEFAULT_RPC_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_SHUTDOWN_TIMEOUT_MS = 2_000;
export const DEFAULT_LIFECYCLE_CORRELATION_TIMEOUT_MS = 5_000;
export const COMPLETION_RECOVERY_MAX_ENTRIES = 256;
export const COMPLETION_RECOVERY_RAW_SCAN_MAX_ENTRIES = 4_096;
export const COMPLETION_RECOVERY_SIDECAR_MAX_BYTES = 128 * 1024;
export const ROOT_TREE_LIFETIME_IDENTITY_LIMIT = 4_096;
export const MIN_WAIT_DELAY_SECONDS = 1;
export const MAX_WAIT_DELAY_SECONDS = 3_600;
export const CHILD_STOP_GRACE_MS = 1_500;
export const DEFAULT_CHILD_TOOLS = ["read", "bash", "edit", "write"];
export const DEFAULT_CHILD_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "LANG",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
];
export const COLLABORATION_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "delegate",
  "ask_parent",
] as const;
