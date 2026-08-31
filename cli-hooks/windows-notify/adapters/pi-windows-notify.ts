import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function assistantText(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function notifierScript(): string | undefined {
  if (process.env.AI_CLI_NOTIFY_SCRIPT) return process.env.AI_CLI_NOTIFY_SCRIPT;
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return undefined;
  return path.join(home, ".agent-hooks", "windows-notify", "shared", "notify.ps1");
}

function notify(payload: Record<string, unknown>): void {
  if (process.platform !== "win32") return;
  const script = notifierScript();
  if (!script) return;
  try {
    const child = spawn(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch {
    // Notification failures must never affect the Pi agent loop.
  }
}

export default function (pi: ExtensionAPI) {
  let lastAssistantMessage = "";
  let lastCwd = "";

  pi.on("agent_start", () => {
    lastAssistantMessage = "";
  });

  pi.on("turn_end", (event, ctx) => {
    const text = assistantText(event.message);
    if (!text) return;
    lastAssistantMessage = text;
    lastCwd = ctx.cwd;
  });

  pi.on("agent_settled", (_event, ctx) => {
    const message = lastAssistantMessage.trim();
    if (!message) return;
    notify({
      source: "Pi",
      event: "complete",
      title: "Pi completed",
      message,
      cwd: lastCwd || ctx.cwd,
    });
    lastAssistantMessage = "";
  });
}
