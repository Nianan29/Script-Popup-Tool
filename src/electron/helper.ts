import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";

export interface InputClickedEvent {
  type: "input-clicked";
  x: number;
  y: number;
  processName: string;
  windowTitle: string;
  windowHandle: string;
  controlType?: string;
}

export interface MouseClickedEvent {
  type: "mouse-clicked";
  x: number;
  y: number;
  processName: string;
  windowTitle: string;
  windowHandle: string;
}

export interface ForegroundChangedEvent {
  type: "foreground-changed";
  processName: string;
  windowTitle: string;
  windowHandle: string;
}

export interface ForegroundSnapshotEvent {
  type: "foreground-snapshot";
  requestId: string;
  processName: string;
  windowTitle: string;
  windowHandle: string;
}

export interface HelperLogEvent {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
}

export type HelperEvent =
  | InputClickedEvent
  | MouseClickedEvent
  | ForegroundChangedEvent
  | ForegroundSnapshotEvent
  | HelperLogEvent;

export class InputWatcherClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private readonly listeners = new Set<(event: HelperEvent) => void>();

  start(): void {
    if (this.child) {
      return;
    }

    const command = resolveHelperCommand();
    this.child = spawn(command.file, command.args, {
      cwd: command.cwd,
      stdio: "pipe",
      windowsHide: true
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      console.error(`[InputWatcher] ${chunk.trim()}`);
    });
    this.child.on("exit", (code, signal) => {
      console.warn(`InputWatcher exited. code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.child = undefined;
    });
  }

  stop(): void {
    if (!this.child) {
      return;
    }

    this.child.kill();
    this.child = undefined;
  }

  onEvent(listener: (event: HelperEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pause(): void {
    this.send({ type: "pause" });
  }

  resume(): void {
    this.send({ type: "resume" });
  }

  reloadConfig(): void {
    this.send({ type: "reload-config" });
  }

  paste(windowHandle: string): void {
    this.send({ type: "paste", windowHandle });
  }

  getForeground(requestId: string): void {
    this.send({ type: "get-foreground", requestId });
  }

  private send(payload: unknown): void {
    if (!this.child || this.child.killed) {
      return;
    }

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");

      if (!line) {
        continue;
      }

      try {
        const event = JSON.parse(line) as HelperEvent;
        for (const listener of this.listeners) {
          listener(event);
        }
      } catch (error) {
        console.error("Failed to parse InputWatcher event", line, error);
      }
    }
  }
}

function resolveHelperCommand(): { file: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    return {
      file: path.join(process.resourcesPath, "InputWatcher", "InputWatcher.exe"),
      args: [],
      cwd: process.resourcesPath
    };
  }

  const projectPath = path.resolve(process.cwd(), "native", "InputWatcher", "InputWatcher.csproj");
  return {
    file: "dotnet",
    args: ["run", "--project", projectPath, "--no-launch-profile"],
    cwd: process.cwd()
  };
}
