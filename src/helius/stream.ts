import WebSocket from "ws";
import { env } from "../config/env";
import { log } from "../utils/logger";
import { DEX_PROGRAM_IDS } from "../config/constants";

export type Activity = {
  programLabel: string;
  programId: string;
  signature: string;
  logs: string[];
};

/**
 * WebSocket connection to Helius for DEX activity triggers.
 * Subscribes to either specific accounts or all DEX program logs.
 * Includes exponential backoff reconnection.
 */
export class HeliusDexStream {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private reqToLabel = new Map<number, string>();
  private onActivity: (activity: Activity) => void;

  constructor(onActivity: (activity: Activity) => void) {
    this.onActivity = onActivity;
  }

  connect(): void {
    if (!env.EVENTS_ENABLED || this.closed) return;

    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.reqToLabel.clear();
      let id = 1;

      const watchedAccounts = env.WATCH_ACCOUNTS
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (watchedAccounts.length > 0) {
        for (const account of watchedAccounts) {
          const requestId = id++;
          this.reqToLabel.set(requestId, `account:${account}`);
          this.ws?.send(JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: "accountSubscribe",
            params: [account, { commitment: "processed", encoding: "base64" }],
          }));
        }
      } else if (env.WATCH_DEX_PROGRAMS) {
        for (const [label, programId] of Object.entries(DEX_PROGRAM_IDS)) {
          const requestId = id++;
          this.reqToLabel.set(requestId, label);
          this.ws?.send(JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: "logsSubscribe",
            params: [{ mentions: [programId] }, { commitment: "processed" }],
          }));
        }
      }

      log.info(
        watchedAccounts.length > 0
          ? `Helius WS connected; watching ${watchedAccounts.length} configured account(s)`
          : "Helius WS connected; watching all DEX program logs",
      );
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

        if (msg.method === "accountNotification") {
          const subscriptionId = (msg.params as Record<string, unknown>)?.subscription as number;
          const label = this.reqToLabel.get(subscriptionId) ?? "watched-account";
          this.onActivity({
            programLabel: label,
            programId: label.startsWith("account:") ? label.slice(8) : label,
            signature: `account:${subscriptionId}`,
            logs: [],
          });
          return;
        }

        if (msg.method === "logsNotification") {
          const params = msg.params as Record<string, unknown> | undefined;
          const value = params?.result as Record<string, unknown> | undefined;
          const signature = value?.signature as string;
          const logs = value?.logs as string[];
          if (!signature || !Array.isArray(logs)) return;
          const text = logs.join(" ");
          for (const [label, programId] of Object.entries(DEX_PROGRAM_IDS)) {
            if (text.includes(programId)) {
              this.onActivity({ programLabel: label, programId, signature, logs });
              break;
            }
          }
        }
      } catch (error) {
        log.warn({ error: String(error) }, "Invalid Helius WS message");
      }
    });

    this.ws.on("error", (error) => log.warn({ error: error.message }, "Helius WS error"));
    this.ws.on("close", () => {
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      log.warn(`Helius WS closed; reconnecting in ${delay}ms`);
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.reqToLabel.clear();
  }
}
