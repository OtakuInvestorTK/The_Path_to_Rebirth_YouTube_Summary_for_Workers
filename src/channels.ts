export type ThumbnailMap = Record<string, { url: string; width?: number; height?: number }>;

export type LiveStreamingInfo = {
  status: "live" | "upcoming" | "completed";
  scheduledStartTime?: string;
  actualStartTime?: string;
  scheduledEndTime?: string;
  actualEndTime?: string;
  concurrentViewers?: number;
};

const API_BASE = "https://www.googleapis.com/youtube/v3/";
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type ChannelsApiResponse = {
  requestedAt: string;
  channels: ChannelResult[];
};

export type ChannelResult = ChannelVideos & {
  input: string;
  channelTitle: string;
  channelThumbnails: ThumbnailMap;
};

export type ChannelVideos = {
  channelId: string;
  liveVideos: VideoSummary[];
  recentVideos: VideoSummary[];
};

export type VideoSummary = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  channelTitle: string;
  thumbnails: ThumbnailMap;
  liveStreaming?: LiveStreamingInfo;
};

export class ChannelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelResolutionError";
  }
}

// カンマ区切りの入力から有効な識別子配列を生成
export function parseIdentifiers(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// 指定されたチャンネル群のライブ/動画情報をまとめたペイロードを取得
export async function fetchChannelsPayload(
  identifiers: string[],
  apiKey: string,
): Promise<ChannelsApiResponse> {
  if (identifiers.length === 0) {
    throw new ChannelResolutionError("No channel identifiers provided");
  }

  const resolved: ResolvedChannel[] = [];

  for (const identifier of identifiers) {
    try {
      const info = await resolveChannel(identifier, apiKey);
      resolved.push({ input: identifier, ...info });
    } catch (error) {
      throw new ChannelResolutionError(
        `Failed to resolve channel "${identifier}": ${toMessage(error)}`,
      );
    }
  }

  const uploadsMap = await fetchUploadsPlaylistMap(resolved.map((item) => item.channelId), apiKey);

  const results: ChannelResult[] = await Promise.all(
    resolved.map(async ({ input, channelId, channelTitle, channelThumbnails }) => {
      const videos = await fetchChannelData(channelId, uploadsMap.get(channelId), apiKey);
      return { input, channelTitle, channelThumbnails, ...videos };
    }),
  );

  return {
    requestedAt: new Date().toISOString(),
    channels: results,
  };
}

type ResolvedChannel = ResolvedChannelInfo & {
  input: string;
};

type ResolvedChannelInfo = {
  channelId: string;
  channelTitle: string;
  channelThumbnails: ThumbnailMap;
};

// 入力文字列からチャンネル ID を解決
async function resolveChannel(identifier: string, apiKey: string): Promise<ResolvedChannelInfo> {
  if (isChannelId(identifier)) {
    const byId = await fetchChannelById(identifier, apiKey);
    if (byId) {
      return byId;
    }
    throw new Error("Channel ID not found");
  }

  const handleCandidate = identifier.startsWith("@") ? identifier : `@${identifier}`;
  const handleResolution = await fetchChannelByHandle(handleCandidate, apiKey);
  if (handleResolution) {
    return handleResolution;
  }

  const usernameCandidate = identifier.replace(/^@+/, "");
  const usernameResolution = await fetchChannelByUsername(usernameCandidate, apiKey);
  if (usernameResolution) {
    return usernameResolution;
  }

  const searchResolution = await fetchChannelBySearch(identifier, apiKey);
  if (searchResolution) {
    return searchResolution;
  }

  throw new Error("No matching channel found");
}

// チャンネルハンドルでチャンネル情報を取得
async function fetchChannelByHandle(handle: string, apiKey: string): Promise<ResolvedChannelInfo | undefined> {
  const response = await youtubeApiFetch<YouTubeChannelsResponse>(
    "channels",
    apiKey,
    {
      part: "id,snippet",
      forHandle: handle,
      maxResults: "1",
    },
  );

  return toResolvedChannelInfo(response.items?.[0]);
}

// カスタム URL (ユーザー名) でチャンネル情報を取得
async function fetchChannelByUsername(username: string, apiKey: string): Promise<ResolvedChannelInfo | undefined> {
  if (!username) {
    return undefined;
  }

  const response = await youtubeApiFetch<YouTubeChannelsResponse>(
    "channels",
    apiKey,
    {
      part: "id,snippet",
      forUsername: username,
      maxResults: "1",
    },
  );

  return toResolvedChannelInfo(response.items?.[0]);
}

// キーワード検索で最適なチャンネルを探索
async function fetchChannelBySearch(query: string, apiKey: string): Promise<ResolvedChannelInfo | undefined> {
  const response = await youtubeApiFetch<YouTubeSearchResponse>(
    "search",
    apiKey,
    {
      part: "snippet",
      q: query,
      type: "channel",
      maxResults: "1",
    },
  );

  const item = response.items?.[0];
  if (!item?.snippet?.channelId) {
    return undefined;
  }

  return {
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    channelThumbnails: item.snippet.thumbnails ?? {},
  };
}

// チャンネル ID からチャンネル情報を取得
async function fetchChannelById(channelId: string, apiKey: string): Promise<ResolvedChannelInfo | undefined> {
  const response = await youtubeApiFetch<YouTubeChannelsResponse>(
    "channels",
    apiKey,
    {
      part: "id,snippet",
      id: channelId,
      maxResults: "1",
    },
  );

  return toResolvedChannelInfo(response.items?.[0]);
}

// YouTube API のチャンネルレスポンスを内部表現へ変換
function toResolvedChannelInfo(item?: YouTubeChannelItem): ResolvedChannelInfo | undefined {
  if (!item?.id) {
    return undefined;
  }

  return {
    channelId: item.id,
    channelTitle: item.snippet?.title ?? item.id,
    channelThumbnails: item.snippet?.thumbnails ?? {},
  };
}

// 指定チャンネルのライブ動画と直近 1 週間の動画一覧を取得
async function fetchChannelData(
  channelId: string,
  uploadsPlaylistId: string | undefined,
  apiKey: string,
): Promise<ChannelVideos> {
  const publishedAfter = new Date(Date.now() - ONE_WEEK_MS).toISOString();

  const [liveVideos, recentVideos] = await Promise.all([
    fetchLiveVideos({ channelId, apiKey }),
    fetchUploadsPlaylistVideos({
      apiKey,
      playlistId: uploadsPlaylistId,
      publishedAfter,
      maxResults: 20,
    }),
  ]);

  return {
    channelId,
    liveVideos,
    recentVideos,
  };
}

// ライブ配信中または予定中の動画一覧を取得
async function fetchLiveVideos({
  channelId,
  apiKey,
}: {
  channelId: string;
  apiKey: string;
}): Promise<VideoSummary[]> {
  const searchData = await youtubeApiFetch<YouTubeSearchResponse>(
    "search",
    apiKey,
    {
      part: "snippet",
      channelId,
      eventType: "live",
      type: "video",
      order: "date",
      maxResults: "10",
    },
  );

  const searchItems = searchData.items ?? [];
  const videoIds = searchItems
    .map((item) => item.id?.videoId)
    .filter((id): id is string => Boolean(id));

  if (videoIds.length === 0) {
    return [];
  }

  const videosData = await youtubeApiFetch<YouTubeVideosResponse>(
    "videos",
    apiKey,
    {
      part: "snippet,liveStreamingDetails",
      id: videoIds.join(","),
    },
  );

  const detailMap = new Map<string, YouTubeVideoItem>();
  for (const item of videosData.items ?? []) {
    if (item.id) {
      detailMap.set(item.id, item);
    }
  }

  return videoIds
    .map((videoId) => {
      const detail = detailMap.get(videoId);
      const snippet = detail?.snippet ?? searchItems.find((s) => s.id?.videoId === videoId)?.snippet;
      return buildVideoSummary(videoId, snippet, detail?.liveStreamingDetails);
    })
    .filter((video): video is VideoSummary => Boolean(video));
}

// Search API で通常動画を取得し整形
async function fetchUploadsPlaylistVideos({
  apiKey,
  playlistId,
  publishedAfter,
  maxResults,
}: {
  apiKey: string;
  playlistId?: string;
  publishedAfter: string;
  maxResults: number;
}): Promise<VideoSummary[]> {
  if (!playlistId) {
    return [];
  }

  const data = await youtubeApiFetch<YouTubePlaylistItemsResponse>(
    "playlistItems",
    apiKey,
    {
      part: "snippet",
      playlistId,
      maxResults: String(maxResults),
    },
  );

  const items = data.items ?? [];
  const publishedAfterTime = new Date(publishedAfter).getTime();

  const recent = items
    .map((item) => toPlaylistVideoSummary(item))
    .filter((video): video is VideoSummary => Boolean(video))
    .filter((video) => new Date(video.publishedAt).getTime() >= publishedAfterTime);

  return recent;
}

async function fetchUploadsPlaylistMap(channelIds: string[], apiKey: string): Promise<Map<string, string>> {
  if (channelIds.length === 0) {
    return new Map();
  }

  const response = await youtubeApiFetch<YouTubeChannelsResponse>(
    "channels",
    apiKey,
    {
      part: "contentDetails",
      id: channelIds.join(","),
      maxResults: String(channelIds.length),
    },
  );

  const map = new Map<string, string>();

  for (const item of response.items ?? []) {
    const uploadsId = item.contentDetails?.relatedPlaylists?.uploads;
    if (item.id && uploadsId) {
      map.set(item.id, uploadsId);
    }
  }

  return map;
}

// YouTube Data API への共通 GET リクエスト
async function youtubeApiFetch<T>(
  path: string,
  apiKey: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(path, API_BASE);

  Object.entries({ key: apiKey, ...params }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`YouTube API error (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as T;
}

// API レスポンスを VideoSummary 形式に整形
function buildVideoSummary(
  videoId: string,
  snippet?: {
    title: string;
    description: string;
    publishedAt: string;
    channelTitle: string;
    thumbnails?: ThumbnailMap;
    liveBroadcastContent?: string;
  },
  liveDetails?: YouTubeLiveStreamingDetails,
): VideoSummary | undefined {
  if (!snippet) {
    return undefined;
  }

  const summary: VideoSummary = {
    videoId,
    title: snippet.title,
    description: snippet.description,
    publishedAt: snippet.publishedAt,
    channelTitle: snippet.channelTitle,
    thumbnails: snippet.thumbnails ?? {},
  };

  const status = snippet.liveBroadcastContent;
  if (status && status !== "none") {
    const liveStreaming: LiveStreamingInfo = {
      status: status === "live" || status === "upcoming" ? status : "completed",
      scheduledStartTime: liveDetails?.scheduledStartTime,
      actualStartTime: liveDetails?.actualStartTime,
      scheduledEndTime: liveDetails?.scheduledEndTime,
      actualEndTime: liveDetails?.actualEndTime,
    };

    if (liveDetails?.concurrentViewers) {
      const parsed = Number(liveDetails.concurrentViewers);
      if (Number.isFinite(parsed)) {
        liveStreaming.concurrentViewers = parsed;
      }
    }

    summary.liveStreaming = liveStreaming;
  }

  return summary;
}

// Search API の item から VideoSummary を生成
function toVideoSummary(item: YouTubeSearchItem): VideoSummary | undefined {
  const videoId = item.id?.videoId;
  const snippet = item.snippet;
  if (!videoId || !snippet) {
    return undefined;
  }

  return buildVideoSummary(videoId, snippet);
}

function toPlaylistVideoSummary(item: YouTubePlaylistItem): VideoSummary | undefined {
  const snippet = item.snippet;
  const videoId = snippet?.resourceId?.videoId;
  if (!videoId || !snippet) {
    return undefined;
  }

  return buildVideoSummary(videoId, {
    title: snippet.title,
    description: snippet.description ?? "",
    publishedAt: snippet.publishedAt ?? new Date().toISOString(),
    channelTitle: snippet.channelTitle ?? "",
    thumbnails: snippet.thumbnails,
  });
}

// 文字列が UC 形式のチャンネル ID か判定
function isChannelId(identifier: string): boolean {
  return /^UC[a-zA-Z0-9_-]{21}[AQgw]?$/u.test(identifier);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface YouTubeChannelsResponse {
  items?: YouTubeChannelItem[];
}

interface YouTubeChannelItem {
  id?: string;
  snippet?: {
    title?: string;
    thumbnails?: ThumbnailMap;
  };
  contentDetails?: {
    relatedPlaylists?: {
      uploads?: string;
    };
  };
}

interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
}

interface YouTubeSearchItem {
  id?: {
    videoId?: string;
  };
  snippet?: {
    title: string;
    description: string;
    publishedAt: string;
    channelId?: string;
    channelTitle: string;
    thumbnails?: ThumbnailMap;
    liveBroadcastContent?: string;
  };
}

interface YouTubeVideosResponse {
  items?: YouTubeVideoItem[];
}

interface YouTubeVideoItem {
  id?: string;
  snippet?: {
    title: string;
    description: string;
    publishedAt: string;
    channelId?: string;
    channelTitle: string;
    thumbnails?: ThumbnailMap;
    liveBroadcastContent?: string;
  };
  liveStreamingDetails?: YouTubeLiveStreamingDetails;
}

interface YouTubeLiveStreamingDetails {
  scheduledStartTime?: string;
  actualStartTime?: string;
  scheduledEndTime?: string;
  actualEndTime?: string;
  concurrentViewers?: string;
}

interface YouTubePlaylistItemsResponse {
  items?: YouTubePlaylistItem[];
}

interface YouTubePlaylistItem {
  snippet?: {
    title: string;
    description?: string;
    publishedAt?: string;
    channelTitle?: string;
    thumbnails?: ThumbnailMap;
    resourceId?: {
      videoId?: string;
    };
  };
}
