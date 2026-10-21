import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAdapterContractTests } from "../tests/adapter-contract-tests.js";
import { buildRequest } from "../tests/test-helpers.js";
import {
  AGY_MODELS,
  createAgyRuntime,
  discoverAgyModels,
  editFromAgyToolInput,
  extractUserPrompt,
  parseAgySession,
} from "./agy.js";

const { execAbortableMock } = vi.hoisted(() => ({
  execAbortableMock: vi.fn(),
}));

vi.mock("../exec.js", () => ({
  execAbortable: execAbortableMock,
}));

runAdapterContractTests({
  name: "agy",
  createRuntime: createAgyRuntime,
  defaultModel: "gemini-3.8-flash-high",
  mockExec: () => execAbortableMock,
});

describe("agy adapter", () => {
  beforeEach(() => {
    execAbortableMock.mockReset();
  });

  it("executes prompt with expected default flags", async () => {
    execAbortableMock.mockResolvedValue({ stdout: "Hello from agy", stderr: "" });

    const runtime = createAgyRuntime();
    const result = await runtime.execute(
      buildRequest({
        model: "gemini-3.8-flash-high",
        prompt: "Say hello",
      }),
    );

    expect(execAbortableMock).toHaveBeenCalledWith(
      "agy",
      [
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
        "--model",
        "gemini-3.8-flash-high",
        "-p",
        expect.any(String),
      ],
      expect.objectContaining({
        maxBuffer: 50 * 1024 * 1024,
      }),
    );
    expect(result.raw).toBe("Hello from agy");
    expect(result.exitCode).toBe(0);
  });

  it("omits --model flag when model is default", async () => {
    execAbortableMock.mockResolvedValue({ stdout: "default model output", stderr: "" });

    const runtime = createAgyRuntime();
    await runtime.execute(buildRequest({ model: "default" }));

    expect(execAbortableMock).toHaveBeenCalledWith(
      "agy",
      [
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
        "-p",
        expect.any(String),
      ],
      expect.any(Object),
    );
  });

  it("passes extraArgs before prompt argument", async () => {
    execAbortableMock.mockResolvedValue({ stdout: "extra output", stderr: "" });

    const runtime = createAgyRuntime();
    await runtime.execute(
      buildRequest({
        model: "gemini-3.8-flash-high",
        overrides: { extraArgs: ["--effort", "high"] },
      }),
    );

    expect(execAbortableMock).toHaveBeenCalledWith(
      "agy",
      [
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
        "--model",
        "gemini-3.8-flash-high",
        "--effort",
        "high",
        "-p",
        expect.any(String),
      ],
      expect.any(Object),
    );
  });

  it("respects command override", async () => {
    execAbortableMock.mockResolvedValue({ stdout: "custom cmd output", stderr: "" });

    const runtime = createAgyRuntime();
    await runtime.execute(
      buildRequest({
        overrides: { command: "/opt/bin/agy-custom" },
      }),
    );

    expect(execAbortableMock).toHaveBeenCalledWith(
      "/opt/bin/agy-custom",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("handles promptFile reading if available", async () => {
    const tmpPrompt = path.join(os.tmpdir(), `test-prompt-${Date.now()}.txt`);
    fs.writeFileSync(tmpPrompt, "Prompt from file content");

    execAbortableMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    const runtime = createAgyRuntime();
    await runtime.execute(
      buildRequest({
        promptFile: tmpPrompt,
      }),
    );

    expect(execAbortableMock).toHaveBeenCalledWith(
      "agy",
      expect.arrayContaining(["-p", "Prompt from file content"]),
      expect.any(Object),
    );

    fs.unlinkSync(tmpPrompt);
  });
});

describe("agy discoverModels", () => {
  it("returns static seed by default or when settings file is absent", () => {
    const models = discoverAgyModels();
    expect(models).toEqual(expect.arrayContaining([...AGY_MODELS]));
  });
});

describe("extractUserPrompt", () => {
  it("extracts text wrapped inside <USER_REQUEST>", () => {
    const raw = `<USER_REQUEST>\nDo the task\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime=now\n</ADDITIONAL_METADATA>`;
    expect(extractUserPrompt(raw)).toBe("Do the task");
  });

  it("returns raw trimmed text when no wrapper tags exist", () => {
    expect(extractUserPrompt("  plain prompt  ")).toBe("plain prompt");
  });
});

describe("editFromAgyToolInput", () => {
  it("extracts write_to_file edits with TargetFile and CodeContent", () => {
    const block = editFromAgyToolInput("write_to_file", {
      TargetFile: "/path/to/file.ts",
      CodeContent: "const x = 1;",
    });
    expect(block).toEqual({
      kind: "edit",
      path: "/path/to/file.ts",
      before: "",
      after: "const x = 1;",
    });
  });

  it("extracts replace_file_content edits", () => {
    const block = editFromAgyToolInput("replace_file_content", {
      TargetFile: "/path/to/file.ts",
      TargetContent: "const x = 1;",
      ReplacementContent: "const x = 2;",
    });
    expect(block).toEqual({
      kind: "edit",
      path: "/path/to/file.ts",
      before: "const x = 1;",
      after: "const x = 2;",
    });
  });

  it("returns null for non-edit tool inputs", () => {
    expect(editFromAgyToolInput("view_file", { AbsolutePath: "/foo" })).toBeNull();
  });
});

describe("parseAgySession", () => {
  it("parses user inputs, thinking, tool calls, and results into a unified transcript", () => {
    const tmpSession = path.join(os.tmpdir(), `agy-session-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-10-21T12:00:00Z",
        content: "<USER_REQUEST>\nFix the bug\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-10-21T12:00:01Z",
        input_tokens: 1500,
        output_tokens: 120,
        thinking: "Need to replace the bug line",
        tool_calls: [
          {
            name: "replace_file_content",
            args: {
              TargetFile: "/src/index.ts",
              TargetContent: "badCode()",
              ReplacementContent: "goodCode()",
              toolAction: "Fixing call",
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-10-21T12:00:02Z",
        content: "File replaced successfully.",
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-10-21T12:00:03Z",
        input_tokens: 500,
        output_tokens: 40,
        content: "All done!",
      }),
    ];

    fs.writeFileSync(tmpSession, lines.join("\n"));
    const transcript = parseAgySession(tmpSession);
    fs.unlinkSync(tmpSession);

    expect(transcript).not.toBeNull();
    expect(transcript?.runtime).toBe("agy");
    expect(transcript?.messages).toHaveLength(4);

    // User turn
    expect(transcript?.messages[0].role).toBe("user");
    expect(transcript?.messages[0].blocks[0]).toEqual({ kind: "text", text: "Fix the bug" });

    // Assistant turn with thinking and tool use + edit
    expect(transcript?.messages[1].role).toBe("assistant");
    expect(transcript?.messages[1].blocks).toEqual(
      expect.arrayContaining([
        { kind: "thinking", text: "Need to replace the bug line" },
        expect.objectContaining({ kind: "tool_use", name: "replace_file_content" }),
        {
          kind: "edit",
          path: "/src/index.ts",
          before: "badCode()",
          after: "goodCode()",
        },
      ]),
    );

    // Tool turn
    expect(transcript?.messages[2].role).toBe("tool");
    expect(transcript?.messages[2].blocks[0]).toEqual({
      kind: "tool_result",
      ok: true,
      text: "File replaced successfully.",
    });

    // Final response
    expect(transcript?.messages[3].role).toBe("assistant");
    expect(transcript?.messages[3].blocks[0]).toEqual({ kind: "text", text: "All done!" });

    // Usage
    expect(transcript?.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 160,
    });
  });

  it("returns null for empty session file", () => {
    const tmpEmpty = path.join(os.tmpdir(), `empty-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpEmpty, "");
    const res = parseAgySession(tmpEmpty);
    fs.unlinkSync(tmpEmpty);
    expect(res).toBeNull();
  });
});
