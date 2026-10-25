import axios from "axios";
import { summarizeError } from "./errorSummary.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface ExpoPushMessage {
  to: string | string[];
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  channelId?: string;
  priority?: "default" | "normal" | "high";
}

export async function sendExpoPushNotifications(
  messages: ExpoPushMessage[]
): Promise<void> {
  if (!messages.length) return;

  // Expo recommends batches of up to 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      await axios.post(EXPO_PUSH_URL, batch, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      console.error(
        `[ExpoPush] Failed to send batch of ${batch.length}`,
        summarizeError(err)
      );
    }
  }
}

/**
 * Build push messages for a list of Expo push tokens.
 * Filters out invalid tokens automatically.
 */
export function buildPushMessages(
  tokens: string[],
  payload: {
    title?: string;
    body: string;
    data?: Record<string, unknown>;
    channelId?: string;
  }
): ExpoPushMessage[] {
  const valid = tokens.filter(
    (t) => typeof t === "string" && t.startsWith("ExponentPushToken[")
  );
  if (!valid.length) return [];

  return valid.map((token) => ({
    to: token,
    sound: "default" as const,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    priority: "high" as const,
    channelId: payload.channelId || "app-notifications",
  }));
}
