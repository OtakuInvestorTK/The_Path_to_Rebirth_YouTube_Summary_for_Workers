import {
  ChannelResolutionError,
  ChannelsApiResponse,
  fetchChannelsPayload,
  parseIdentifiers,
} from "./channels";

export interface Env {
  YOUTUBE_API_KEY: string;
  YOUTUBE_CHANNEL_IDS_1?: string;
  YOUTUBE_CHANNEL_IDS_2?: string;
  YOUTUBE_CHANNEL_IDS_3?: string;
  YOUTUBE_CHANNEL_IDS_4?: string;
  YOUTUBE_CHANNEL_IDS_5?: string;
  YOUTUBE_CHANNEL_IDS_6?: string;
  YOUTUBE_CHANNEL_IDS_7?: string;
  YOUTUBE_CHANNEL_IDS_8?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// JSON レスポンスを返しつつ共通ヘッダーを付与する
function createJsonResponse<T>(data: T, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(data), { ...init, headers });
}

// CORS プリフライト要求に対応
function createOptionsResponse(): Response {
  const headers = new Headers(CORS_HEADERS);
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return createOptionsResponse();
      }

      if (url.pathname === "/") {
        return createJsonResponse({
          message: "Use GET /channels?group=N to fetch channel data.",
        });
      }

      if (url.pathname === "/channels") {
        return await handleChannelsRequest(url, env);
      }

      return createJsonResponse({ error: "Not Found" }, { status: 404 });
    } catch (error) {
      return createJsonResponse({ error: toMessage(error) }, { status: 500 });
    }
  },
};

// /channels リクエストを処理し、チャンネル情報を組み立てて返す
async function handleChannelsRequest(url: URL, env: Env): Promise<Response> {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return createJsonResponse(
      { error: "Missing YOUTUBE_API_KEY binding" },
      { status: 500 }
    );
  }

  const idsResolution = resolveChannelIds(url, env);
  if (idsResolution.error) {
    return idsResolution.error;
  }

  const identifiers = parseIdentifiers(idsResolution.ids);

  if (identifiers.length === 0) {
    return createJsonResponse(
      { error: "Channel ID list for this group is empty." },
      { status: 400 }
    );
  }

  try {
    const payload = await fetchChannelsPayload(identifiers, apiKey);
    return createJsonResponse<ChannelsApiResponse>(payload);
  } catch (error) {
    if (error instanceof ChannelResolutionError) {
      return createJsonResponse({ error: error.message }, { status: 400 });
    }

    throw error;
  }
}

// 例外を安全に文字列へ変換
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveChannelIds(
  url: URL,
  env: Env
): { ids?: string; error?: Response } {
  const group = url.searchParams.get("group");
  if (!group) {
    return {
      error: createJsonResponse(
        {
          error: "Missing required group parameter. Use ?group=1 or ?group=2.",
        },
        { status: 400 }
      ),
    };
  }

  const byGroup = pickGroupChannelIds(env, group);
  if (!byGroup) {
    return {
      error: createJsonResponse(
        { error: `No channel IDs configured for group "${group}".` },
        { status: 400 }
      ),
    };
  }

  return { ids: byGroup };
}

function pickGroupChannelIds(env: Env, group: string): string | undefined {
  switch (group) {
    case "1":
      return env.YOUTUBE_CHANNEL_IDS_1;
    case "2":
      return env.YOUTUBE_CHANNEL_IDS_2;
    case "3":
      return env.YOUTUBE_CHANNEL_IDS_3;
    case "4":
      return env.YOUTUBE_CHANNEL_IDS_4;
    case "5":
      return env.YOUTUBE_CHANNEL_IDS_5;
    case "6":
      return env.YOUTUBE_CHANNEL_IDS_6;
    case "7":
      return env.YOUTUBE_CHANNEL_IDS_7;
    case "8":
      return env.YOUTUBE_CHANNEL_IDS_8;
    default:
      return undefined;
  }
}
