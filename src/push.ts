import {
  ChannelsApiResponse,
  ChannelResult,
  VideoSummary,
} from "./channels";
import { Env } from "./env";

const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

type CachedAccessToken = {
  token: string;
  expiresAt: number;
};

let cachedAccessToken: CachedAccessToken | undefined;

type PushType = "live" | "upcoming" | "normal";

export type PushResult = {
  type: PushType;
  requestedAt: string;
  target: "device" | "topic";
  targetId: string;
  sent: Array<Record<string, string>>;
  skipped?: string;
  errors?: Array<{ id: string; message: string }>;
};

type CreateJsonResponse = <T>(data: T, init?: ResponseInit) => Response;

export async function handlePushRequest({
  request,
  env,
  createJsonResponse,
}: {
  request: Request;
  url: URL;
  env: Env;
  createJsonResponse: CreateJsonResponse;
}): Promise<Response> {
  if (request.method !== "POST") {
    return createJsonResponse(
      { error: "Method Not Allowed" },
      { status: 405, headers: { Allow: "POST" } }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    return createJsonResponse(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  if (!payload || typeof payload !== "object") {
    return createJsonResponse(
      { error: "Request body must be an object" },
      { status: 400 }
    );
  }

  const { type, deviceToken, deviceId } = payload as {
    type?: unknown;
    deviceToken?: unknown;
    deviceId?: unknown;
  };

  const pushType = toPushType(typeof type === "string" ? type : null);
  if (!pushType) {
    return createJsonResponse(
      { error: "Missing or invalid type parameter" },
      { status: 400 }
    );
  }

  const channelsUrl = env.CHANNELS_JSON_URL;
  if (!channelsUrl) {
    return createJsonResponse(
      { error: "CHANNELS_JSON_URL binding is not configured" },
      { status: 500 }
    );
  }

  const resolvedDeviceToken =
    typeof deviceToken === "string"
      ? deviceToken
      : typeof deviceId === "string"
      ? deviceId
      : undefined;

  const defaultTarget = resolveDefaultTarget(pushType, env);
  if (!resolvedDeviceToken && !defaultTarget) {
    return createJsonResponse(
      { error: "No broadcast target configured for this push type" },
      { status: 500 }
    );
  }

  const snapshot = await fetchChannelsSnapshot(channelsUrl);

  let result: PushResult;

  switch (pushType) {
    case "live":
      result = await handleLivePush({
        snapshot,
        env,
        deviceToken: resolvedDeviceToken,
        defaultTarget,
      });
      break;
    case "upcoming":
      result = await handleUpcomingPush({
        snapshot,
        env,
        deviceToken: resolvedDeviceToken,
        defaultTarget,
      });
      break;
    case "normal":
      result = await handleNormalPush({
        snapshot,
        env,
        deviceToken: resolvedDeviceToken,
        defaultTarget,
      });
      break;
  }

  return createJsonResponse(result);
}

async function fetchChannelsSnapshot(
  url: string
): Promise<ChannelsApiResponse> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch channels snapshot (${response.status}): ${await response.text()}`
    );
  }

  return (await response.json()) as ChannelsApiResponse;
}

interface PushHandlerArgs {
  snapshot: ChannelsApiResponse;
  env: Env;
  deviceToken?: string;
  defaultTarget?: string;
}

async function handleLivePush({
  snapshot,
  env,
  deviceToken,
  defaultTarget,
}: PushHandlerArgs): Promise<PushResult> {
  const datasetTimestamp = new Date(snapshot.requestedAt);
  const candidateVideos = collectVideos(snapshot.channels, "live").filter(
    (item) => {
      const status = item.video.liveStreaming?.status;
      const actualStart = item.video.liveStreaming?.actualStartTime;
      if (status !== "live" || !actualStart) {
        return false;
      }

      return new Date(actualStart).getTime() >= datasetTimestamp.getTime();
    }
  );

  const targetLabel: "device" | "topic" = deviceToken ? "device" : "topic";
  const targetValue = deviceToken ?? (defaultTarget as string);

  const results: Array<Record<string, string>> = [];
  const errors: Array<{ id: string; message: string }> = [];

  for (const { channel, video } of candidateVideos) {
    const thumbnailUrl = selectThumbnailUrl(video.thumbnails);
    const title = `🔴ライブ配信中：${channel.channelTitle}`;
    const body = `${video.title}\n通知を開いて確認する👀`;
    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;

    const data: Record<string, string> = {
      type: "live",
      title,
      body,
      videoId: video.videoId,
      channelId: channel.channelId,
      channelTitle: channel.channelTitle,
      actualStartTime: video.liveStreaming?.actualStartTime ?? "",
      click_action: videoUrl,
    };

    if (thumbnailUrl) {
      data.icon = thumbnailUrl;
      data.image = thumbnailUrl;
    }

    try {
      await sendFcmMessage({
        env,
        targetType: targetLabel,
        targetValue,
        data,
      });

      results.push({ videoId: video.videoId, channelId: channel.channelId });
    } catch (error) {
      errors.push({ id: video.videoId, message: toMessage(error) });
    }
  }

  return {
    type: "live",
    requestedAt: snapshot.requestedAt,
    target: targetLabel,
    targetId: targetValue,
    sent: results,
    ...(errors.length ? { errors } : {}),
  };
}

async function handleUpcomingPush({
  snapshot,
  env,
  deviceToken,
  defaultTarget,
}: PushHandlerArgs): Promise<PushResult> {
  const now = new Date();
  const { startUtc, endUtc } = getJstDayBoundaries(now, 26);

  const candidateVideos = collectVideos(snapshot.channels, "upcoming")
    .filter((item) => {
      const schedule = item.video.liveStreaming?.scheduledStartTime;
      if (!schedule) {
        return false;
      }
      const scheduleTime = new Date(schedule).getTime();
      return scheduleTime >= startUtc.getTime() && scheduleTime <= endUtc.getTime();
    })
    .sort((a, b) => {
      const timeA = new Date(
        a.video.liveStreaming?.scheduledStartTime ?? 0
      ).getTime();
      const timeB = new Date(
        b.video.liveStreaming?.scheduledStartTime ?? 0
      ).getTime();
      return timeA - timeB;
    });

  const uniqueByChannel = pickUniqueByChannel(candidateVideos);
  const topVideos = uniqueByChannel.slice(0, 3);
  const remainingCount = uniqueByChannel.length - topVideos.length;

  const targetLabel: "device" | "topic" = deviceToken ? "device" : "topic";
  const targetValue = deviceToken ?? (defaultTarget as string);

  if (topVideos.length === 0) {
    return {
      type: "upcoming",
      requestedAt: snapshot.requestedAt,
      target: targetLabel,
      targetId: targetValue,
      sent: [],
      skipped: "No upcoming live streams in the configured window",
    };
  }

  const lines = topVideos.map(({ channel, video }) => {
    const schedule = video.liveStreaming?.scheduledStartTime ?? "";
    return `${channel.channelTitle}：${formatJstTime(schedule)}〜`;
  });

  if (remainingCount > 0) {
    lines.push(`他${remainingCount}本のライブ予定`);
  }

  lines.push("通知を開いて確認する👀");

  const thumbnailUrl = selectThumbnailUrl(topVideos[0].video.thumbnails);

  const notificationTitle = "📅本日のライブ予定";
  const body = lines.join("\n");

  const data: Record<string, string> = {
    type: "upcoming",
    title: notificationTitle,
    body,
    videos: JSON.stringify(
      uniqueByChannel.map(({ channel, video }) => ({
        channelId: channel.channelId,
        channelTitle: channel.channelTitle,
        videoId: video.videoId,
        scheduledStartTime: video.liveStreaming?.scheduledStartTime ?? "",
      }))
    ),
    click_action: "/",
  };

  if (thumbnailUrl) {
    data.icon = thumbnailUrl;
    data.image = thumbnailUrl;
  }

  await sendFcmMessage({
    env,
    targetType: targetLabel,
    targetValue,
    data,
  });

  return {
    type: "upcoming",
    requestedAt: snapshot.requestedAt,
    target: targetLabel,
    targetId: targetValue,
    sent: topVideos.map(({ channel, video }) => ({
      channelId: channel.channelId,
      videoId: video.videoId,
    })),
    ...(remainingCount > 0 ? { skipped: `Truncated ${remainingCount} additional items` } : {}),
  };
}

async function handleNormalPush({
  snapshot,
  env,
  deviceToken,
  defaultTarget,
}: PushHandlerArgs): Promise<PushResult> {
  const now = new Date();
  const threshold = now.getTime() - 24 * 60 * 60 * 1000;

  const candidateVideos = collectVideos(snapshot.channels, "recent")
    .filter(({ video }) => {
      if (video.liveStreaming) {
        return false;
      }
      const publishedAt = new Date(video.publishedAt).getTime();
      return publishedAt >= threshold;
    })
    .sort((a, b) => new Date(b.video.publishedAt).getTime() - new Date(a.video.publishedAt).getTime());

  const uniqueByChannel = pickUniqueByChannel(candidateVideos);
  const topVideos = uniqueByChannel.slice(0, 3);
  const remainingCount = uniqueByChannel.length - topVideos.length;

  const targetLabel: "device" | "topic" = deviceToken ? "device" : "topic";
  const targetValue = deviceToken ?? (defaultTarget as string);

  if (topVideos.length === 0) {
    return {
      type: "normal",
      requestedAt: snapshot.requestedAt,
      target: targetLabel,
      targetId: targetValue,
      sent: [],
      skipped: "No new normal videos in the last 24 hours",
    };
  }

  const lines = topVideos.map(({ channel, video }) => {
    return `${channel.channelTitle}：${video.title}`;
  });

  if (remainingCount > 0) {
    lines.push(`他${remainingCount}本の動画`);
  }

  lines.push("通知を開いて確認する👀");

  const thumbnailUrl = selectThumbnailUrl(topVideos[0].video.thumbnails);

  const notificationTitle = "🆕24時間以内の新着動画";
  const body = lines.join("\n");

  const data: Record<string, string> = {
    type: "normal",
    title: notificationTitle,
    body,
    videos: JSON.stringify(
      uniqueByChannel.map(({ channel, video }) => ({
        channelId: channel.channelId,
        channelTitle: channel.channelTitle,
        videoId: video.videoId,
        publishedAt: video.publishedAt,
      }))
    ),
    click_action: "/",
  };

  if (thumbnailUrl) {
    data.icon = thumbnailUrl;
    data.image = thumbnailUrl;
  }

  await sendFcmMessage({
    env,
    targetType: targetLabel,
    targetValue,
    data,
  });

  return {
    type: "normal",
    requestedAt: snapshot.requestedAt,
    target: targetLabel,
    targetId: targetValue,
    sent: topVideos.map(({ channel, video }) => ({
      channelId: channel.channelId,
      videoId: video.videoId,
    })),
    ...(remainingCount > 0 ? { skipped: `Truncated ${remainingCount} additional items` } : {}),
  };
}

function collectVideos(
  channels: ChannelResult[],
  mode: "live" | "upcoming" | "recent"
): Array<{ channel: ChannelResult; video: VideoSummary }> {
  const results: Array<{ channel: ChannelResult; video: VideoSummary }> = [];

  for (const channel of channels) {
    if (mode === "recent") {
      for (const video of channel.recentVideos) {
        results.push({ channel, video });
      }
      continue;
    }

    for (const video of channel.liveVideos) {
      const status = video.liveStreaming?.status;
      if (mode === "live" && status === "live") {
        results.push({ channel, video });
      }
      if (mode === "upcoming" && status === "upcoming") {
        results.push({ channel, video });
      }
    }
  }

  return results;
}

function pickUniqueByChannel(
  items: Array<{ channel: ChannelResult; video: VideoSummary }>
): Array<{ channel: ChannelResult; video: VideoSummary }> {
  const seen = new Set<string>();
  const results: Array<{ channel: ChannelResult; video: VideoSummary }> = [];

  for (const item of items) {
    const key = item.channel.channelId ?? item.channel.input;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(item);
  }

  return results;
}

function selectThumbnailUrl(thumbnails: VideoSummary["thumbnails"]): string | undefined {
  if (!thumbnails) {
    return undefined;
  }

  const preference = ["maxres", "standard", "high", "medium", "default"];
  for (const key of preference) {
    const candidate = thumbnails[key];
    if (candidate?.url) {
      return candidate.url;
    }
  }

  const fallbackKey = Object.keys(thumbnails)[0];
  return fallbackKey ? thumbnails[fallbackKey]?.url : undefined;
}

function formatJstTime(iso: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const hours = String(jst.getUTCHours()).padStart(2, "0");
  const minutes = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getJstDayBoundaries(now: Date, endHour: number): {
  startUtc: Date;
  endUtc: Date;
} {
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jstNow.getUTCFullYear();
  const month = jstNow.getUTCMonth();
  const day = jstNow.getUTCDate();

  const startUtcMs = Date.UTC(year, month, day) - JST_OFFSET_MS;
  const endUtcMs = startUtcMs + endHour * 60 * 60 * 1000;

  return { startUtc: new Date(startUtcMs), endUtc: new Date(endUtcMs) };
}

function resolveDefaultTarget(type: PushType, env: Env): string | undefined {
  switch (type) {
    case "live":
      return env.PUSH_TOPIC_LIVE;
    case "upcoming":
      return env.PUSH_TOPIC_UPCOMING;
    case "normal":
      return env.PUSH_TOPIC_NORMAL;
    default:
      return undefined;
  }
}

async function sendFcmMessage({
  env,
  targetType,
  targetValue,
  data,
}: {
  env: Env;
  targetType: "device" | "topic";
  targetValue: string;
  data?: Record<string, string>;
}): Promise<void> {
  const projectId = env.FCM_PROJECT_ID;
  if (!projectId) {
    throw new Error("Missing FCM_PROJECT_ID binding");
  }

  const accessToken = await getAccessToken(env);

  const message: Record<string, unknown> = {};

  if (data) {
    message.data = data;
  }

  if (targetType === "device") {
    message.token = targetValue;
  } else {
    const topic = targetValue.startsWith("/topics/")
      ? targetValue.slice("/topics/".length)
      : targetValue;
    message.topic = topic;
  }

  const clickAction = data?.click_action;
  if (clickAction) {
    message.webpush = {
      fcm_options: {
        link: clickAction,
      },
    };
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(
      `FCM request failed (${response.status}): ${await response.text()}`
    );
  }
}

async function getAccessToken(env: Env): Promise<string> {
  const clientEmail = env.FCM_CLIENT_EMAIL;
  const privateKeyPem = env.FCM_PRIVATE_KEY;

  if (!clientEmail || !privateKeyPem) {
    throw new Error(
      "Missing FCM client credentials. Set FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY."
    );
  }

  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessToken.expiresAt - 60_000) {
    return cachedAccessToken.token;
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const unsignedToken = `${base64UrlEncodeJson({ alg: "RS256", typ: "JWT" })}.${base64UrlEncodeJson(
    {
      iss: clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_ENDPOINT,
      iat,
      exp,
    }
  )}`;

  const signature = await signJwt(unsignedToken, privateKeyPem);
  const assertion = `${unsignedToken}.${signature}`;

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const tokenResponse = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !tokenResponse.access_token) {
    const reason = tokenResponse.error_description || tokenResponse.error;
    throw new Error(
      `Failed to obtain FCM access token (${response.status}): ${reason ?? "unknown error"}`
    );
  }

  const expiresInMs = (tokenResponse.expires_in ?? 3600) * 1000;
  cachedAccessToken = {
    token: tokenResponse.access_token,
    expiresAt: Date.now() + expiresInMs,
  };

  return tokenResponse.access_token;
}

async function signJwt(unsignedToken: string, pem: string): Promise<string> {
  const key = await importPrivateKey(pem);
  const data = new TextEncoder().encode(unsignedToken);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    data
  );
  return base64UrlEncode(new Uint8Array(signature));
}

type CachedSigningKey = {
  pem: string;
  key: CryptoKey;
};

let cachedSigningKey: CachedSigningKey | undefined;

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  if (cachedSigningKey && cachedSigningKey.pem === normalized) {
    return cachedSigningKey.key;
  }

  const body = normalized
    .replace(/-----BEGIN [^-]+-----/gu, "")
    .replace(/-----END [^-]+-----/gu, "")
    .replace(/\s+/gu, "");

  const binaryKey = base64ToUint8Array(body);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  cachedSigningKey = { pem: normalized, key: cryptoKey };
  return cryptoKey;
}

function base64UrlEncodeJson(value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  return base64UrlEncode(new TextEncoder().encode(json));
}

function base64UrlEncode(input: Uint8Array | ArrayBuffer | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }

  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  const base64 = btoa(binary);
  return base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toPushType(value: string | null): PushType | undefined {
  if (value === "live" || value === "upcoming" || value === "normal") {
    return value;
  }
  return undefined;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
