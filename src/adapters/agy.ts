import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { checkInstalled, extractVersion, runCommand, withDefaults } from "../adapter-base.js";
import {
  asRecord,
  buildTranscript,
  firstString,
  readJsonl,
  roleFor,
  summariseTool,
} from "../transcript.js";
import type {
  RawExecutionOutput,
  RuntimeAdapter,
  RuntimeExecutionRequest,
  RuntimeHealth,
  Transcript,
  TranscriptBlock,
  TranscriptMessage,
  TranscriptUsage,
} from "../types.js";

export const AGY_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

export const AGY_SETTINGS_FILE = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");

/**
 * Discover agy's live model from local CLI settings, unioned with the static models seed.
 */
export function discoverAgyModels(): string[] {
  try {
    if (fs.existsSync(AGY_SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(AGY_SETTINGS_FILE, "utf-8")) as {
        model?: string;
      };
      if (typeof settings.model === "string" && settings.model.trim()) {
        const configuredModel = settings.model.trim();
        return [...new Set([...AGY_MODELS, configuredModel])];
      }
    }
  } catch {}
  return [...AGY_MODELS];
}

export function createAgyRuntime(): RuntimeAdapter {
  return withDefaults({
    type: "cli",
    name: "agy",
    models: AGY_MODELS,
    defaultModel: "gemini-3.8-flash-high",
    supportsCustomPrompt: true,
    capabilities: {
      command: "agy",
      promptStrategy: "file-ref",
      requiresPty: false,
      supportsModelSelection: true,
      authMethods: [
        {
          type: "env",
          keys: ["ANTIGRAVITY_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
        },
        {
          type: "auth-file",
          path: "~/.gemini/antigravity-cli/antigravity-oauth-token",
          description: "Antigravity CLI OAuth token",
        },
        {
          type: "auth-file",
          path: "~/.gemini/oauth_creds.json",
          description: "Gemini OAuth credentials",
        },
      ],
      relevantEnvVars: ["ANTIGRAVITY_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
      supportsSessionCapture: true,
    },

    discoverModels(): string[] {
      return discoverAgyModels();
    },

    async execute(request: RuntimeExecutionRequest): Promise<RawExecutionOutput> {
      const cmd = request.overrides?.command ?? "agy";

      let prompt = request.prompt;
      if (request.promptFile) {
        try {
          prompt = fs.readFileSync(request.promptFile, "utf-8");
        } catch {
          // fallback to request.prompt
        }
      }

      const tempLog = request.sessionFile
        ? path.join(os.tmpdir(), `agy-run-${crypto.randomUUID()}.log`)
        : undefined;

      const args = [
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
        ...(tempLog ? ["--log-file", tempLog] : []),
        ...(request.model !== "default" ? ["--model", request.model] : []),
        ...(request.overrides?.extraArgs ?? []),
        "-p",
        prompt,
      ];

      const result = await runCommand(request, cmd, args);
      if (!request.sessionFile || !tempLog) return result;

      const written = collectAgySession(tempLog, request.sessionFile);
      try {
        if (fs.existsSync(tempLog)) fs.unlinkSync(tempLog);
      } catch {}

      return written ? { ...result, sessionFile: request.sessionFile } : result;
    },

    readTranscript(sessionFile: string): Transcript | null {
      return parseAgySession(sessionFile);
    },

    async healthCheck(): Promise<RuntimeHealth> {
      const name = "agy";
      const check = await checkInstalled(name, "agy");
      if (!check.installed) return check.health;

      const envKey =
        process.env.ANTIGRAVITY_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

      let authenticated: "yes" | "no" | "unknown" = "no";
      let authDetail = "no auth credentials found";

      if (envKey) {
        const found = process.env.ANTIGRAVITY_API_KEY
          ? "ANTIGRAVITY_API_KEY"
          : process.env.GEMINI_API_KEY
            ? "GEMINI_API_KEY"
            : "GOOGLE_API_KEY";
        authenticated = "yes";
        authDetail = `env: ${found}`;
      } else {
        const cliToken = path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
        const credsFile = path.join(os.homedir(), ".gemini", "oauth_creds.json");

        if (fs.existsSync(cliToken)) {
          authenticated = "yes";
          authDetail = "~/.gemini/antigravity-cli/antigravity-oauth-token";
        } else if (fs.existsSync(credsFile)) {
          authenticated = "yes";
          authDetail = "~/.gemini/oauth_creds.json";
        }
      }

      return {
        name,
        command: "agy",
        installed: true,
        version: extractVersion(check.version ?? ""),
        authenticated,
        authDetail,
        error: null,
      };
    },
  });
}

export const createAdapter = createAgyRuntime;

/**
 * Reads the temporary log produced by agy, locates the created conversation ID,
 * and copies the transcript from the local brain store to destination.
 */
export function collectAgySession(logFile: string, destination: string): boolean {
  try {
    if (!fs.existsSync(logFile)) return false;
    const logContent = fs.readFileSync(logFile, "utf-8");
    const match = logContent.match(/Created conversation ([0-9a-fA-F-]+)/);
    if (!match) return false;

    const conversationId = match[1];
    const candidatePaths = [
      path.join(
        os.homedir(),
        ".gemini",
        "antigravity-cli",
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ),
      path.join(
        os.homedir(),
        ".gemini",
        "antigravity",
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ),
    ];

    for (const source of candidatePaths) {
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Cleans user request tags if present in the raw prompt content.
 */
export function extractUserPrompt(raw: string): string {
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return match ? match[1].trim() : raw.trim();
}

/**
 * Extracts a diff-ready edit block from AGY tool calls (e.g. write_to_file or replace_file_content).
 */
export function editFromAgyToolInput(
  name: string,
  input: Record<string, unknown>,
): TranscriptBlock | null {
  const targetPath = firstString(
    input,
    "TargetFile",
    "targetFile",
    "file_path",
    "filePath",
    "path",
  );
  if (!targetPath) return null;

  const before = firstString(
    input,
    "TargetContent",
    "targetContent",
    "old_string",
    "oldString",
    "old_text",
    "oldText",
  );
  const after = firstString(
    input,
    "ReplacementContent",
    "replacementContent",
    "new_string",
    "newString",
    "new_text",
    "newText",
  );
  if (before !== undefined && after !== undefined) {
    return { kind: "edit", path: targetPath, before, after };
  }

  const content = firstString(input, "CodeContent", "codeContent", "content", "text");
  if (content !== undefined && /write|create/i.test(name)) {
    return { kind: "edit", path: targetPath, before: "", after: content };
  }

  return null;
}

function cleanInputArgs(rawArgs: unknown): Record<string, unknown> {
  const record = asRecord(rawArgs);
  if (!record) return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      cleaned[key] = value.slice(1, -1);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function summariseAgyTool(input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };

  return (
    pick("toolSummary", "toolAction", "CommandLine", "AbsolutePath", "TargetFile") ??
    summariseTool(input)
  );
}

/**
 * Parses an AGY session transcript.jsonl into the normalized Transcript format.
 */
export function parseAgySession(sessionFile: string): Transcript | null {
  const events = readJsonl(sessionFile);
  if (events.length === 0) return null;

  const messages: TranscriptMessage[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const event of events) {
    const type = String(event.type ?? "");
    const createdAt = typeof event.created_at === "string" ? event.created_at : undefined;
    const stepIndex = String(event.step_index ?? messages.length);

    if (type === "USER_INPUT") {
      const rawContent = typeof event.content === "string" ? event.content : "";
      const text = extractUserPrompt(rawContent);
      if (text) {
        messages.push({
          id: stepIndex,
          role: "user",
          ...(createdAt ? { at: createdAt } : {}),
          blocks: [{ kind: "text", text }],
        });
      }
      continue;
    }

    if (type === "PLANNER_RESPONSE") {
      const blocks: TranscriptBlock[] = [];

      if (typeof event.thinking === "string" && event.thinking.trim()) {
        blocks.push({ kind: "thinking", text: event.thinking });
      }

      if (typeof event.content === "string" && event.content.trim()) {
        blocks.push({ kind: "text", text: event.content });
      }

      if (Array.isArray(event.tool_calls)) {
        for (const call of event.tool_calls) {
          const callRecord = asRecord(call);
          if (!callRecord) continue;
          const name = String(callRecord.name ?? "tool");
          const input = cleanInputArgs(callRecord.args);
          blocks.push({
            kind: "tool_use",
            ...(typeof callRecord.id === "string" ? { id: callRecord.id } : {}),
            name,
            input,
            summary: summariseAgyTool(input),
          });
          const edit = editFromAgyToolInput(name, input);
          if (edit) blocks.push(edit);
        }
      }

      if (typeof event.input_tokens === "number") totalInputTokens += event.input_tokens;
      if (typeof event.output_tokens === "number") totalOutputTokens += event.output_tokens;

      if (blocks.length > 0) {
        messages.push({
          id: stepIndex,
          role: roleFor("assistant", blocks),
          ...(createdAt ? { at: createdAt } : {}),
          blocks,
        });
      }
      continue;
    }

    if (type === "GENERIC") {
      const text = typeof event.content === "string" ? event.content : "";
      const ok = event.status === "DONE";
      messages.push({
        id: stepIndex,
        role: "tool",
        ...(createdAt ? { at: createdAt } : {}),
        blocks: [{ kind: "tool_result", ok, text }],
      });
    }
  }

  const transcript = buildTranscript("agy", messages);
  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    const usage: TranscriptUsage = {};
    if (totalInputTokens > 0) usage.inputTokens = totalInputTokens;
    if (totalOutputTokens > 0) usage.outputTokens = totalOutputTokens;
    transcript.usage = usage;
  }

  return transcript;
}
