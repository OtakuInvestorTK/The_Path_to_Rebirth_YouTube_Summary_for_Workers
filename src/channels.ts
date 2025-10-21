export type ThumbnailMap = Record<
  string,
  { url: string; width?: number; height?: number }
>;

export type LiveStreamingInfo = {
  status: "live" | "upcoming" | "completed";
  scheduledStartTime?: string;
  actualStartTime?: string;
  scheduledEndTime?: string;
  actualEndTime?: string;
  concurrentViewers?: number;
};

const API_BASE = "https://www.googleapis.com/youtube/v3/";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

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
  viewCount?: number;
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
  apiKey: string
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
        `Failed to resolve channel "${identifier}": ${toMessage(error)}`
      );
    }
  }

  const uploadsMap = await fetchUploadsPlaylistMap(
    resolved.map((item) => item.channelId),
    apiKey
  );

  const results: ChannelResult[] = await Promise.all(
    resolved.map(
      async ({ input, channelId, channelTitle, channelThumbnails }) => {
        const videos = await fetchChannelData(
          channelId,
          uploadsMap.get(channelId),
          apiKey
        );
        return { input, channelTitle, channelThumbnails, ...videos };
      }
    )
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
async function resolveChannel(
  identifier: string,
  apiKey: string
): Promise<ResolvedChannelInfo> {
  if (isChannelId(identifier)) {
    const byId = await fetchChannelById(identifier, apiKey);
    if (byId) {
      return byId;
    }
    throw new Error("Channel ID not found");
  }

  const handleCandidate = identifier.startsWith("@")
    ? identifier
    : `@${identifier}`;
  const handleResolution = await fetchChannelByHandle(handleCandidate, apiKey);
  if (handleResolution) {
    return handleResolution;
  }

  const usernameCandidate = identifier.replace(/^@+/, "");
  const usernameResolution = await fetchChannelByUsername(
    usernameCandidate,
    apiKey
  );
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
async function fetchChannelByHandle(
  handle: string,
  apiKey: string
): Promise<ResolvedChannelInfo | undefined> {
  const response = await youtubeApiFetch<YouTubeChannelsResponse>(
    "channels",
    apiKey,
    {
      part: "id,snippet",
      forHandle: handle,
      maxResults: "1",
    }
  );

  return toResolvedChannelInfo(response.items?.[0]);
}

// カスタム URL (ユーザー名) でチャンネル情報を取得
async function fetchChannelByUsername(
  username: string,
  apiKey: string
): Promise<ResolvedChannelInfo | undefined> {
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
    }
  );

  return toResolvedChannelInfo(response.items?.[0]);
}

// キーワード検索で最適なチャンネルを探索
async function fetchChannelBySearch(
  query: string,
  apiKey: string
): Promise<ResolvedChannelInfo | undefined> {
  const response = await youtubeApiFetch<YouTubeSearchResponse>(
    "search",
    apiKey,
    {
      part: "snippet",
      q: query,
      type: "channel",
      maxResults: "1",
    }
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
async function fetchChannelById(
  channelId: string,
  apiKey: string
): Promise<ResolvedChannelInfo | undefined> {
  const response = await youtubeApiFetch<YouTubeChannelsResponse>(
    "channels",
    apiKey,
    {
      part: "id,snippet",
      id: channelId,
      maxResults: "1",
    }
  );

  return toResolvedChannelInfo(response.items?.[0]);
}

// YouTube API のチャンネルレスポンスを内部表現へ変換
function toResolvedChannelInfo(
  item?: YouTubeChannelItem
): ResolvedChannelInfo | undefined {
  if (!item?.id) {
    return undefined;
  }

  return {
    channelId: item.id,
    channelTitle: item.snippet?.title ?? item.id,
    channelThumbnails: item.snippet?.thumbnails ?? {},
  };
}

// 指定チャンネルの動画一覧を uploads プレイリスト経由で取得し、live情報で仕分け
async function fetchChannelData(
  channelId: string,
  uploadsPlaylistId: string | undefined,
  apiKey: string
): Promise<ChannelVideos> {
  const publishedAfter = new Date(Date.now() - ONE_WEEK_MS).toISOString();

  // search.list は使わず、uploads プレイリスト + videos.list で live 状態を付与
  const summaries = await fetchUploadsPlaylistVideos({
    apiKey,
    playlistId: uploadsPlaylistId,
    publishedAfter,
    maxResults: 20,
  });

  const now = Date.now();
  const filteredSummaries = summaries.filter((video) => {
    if (video.liveStreaming?.status !== "upcoming") {
      return true;
    }
    const reference =
      video.liveStreaming.scheduledStartTime ?? video.publishedAt;
    const referenceTime = new Date(reference).getTime();
    if (Number.isNaN(referenceTime)) {
      return true;
    }
    return now - referenceTime <= ONE_DAY_MS;
  });

  const isLiveOrUpcoming = (v: VideoSummary) =>
    v.liveStreaming?.status === "live" ||
    v.liveStreaming?.status === "upcoming";

  const liveVideos = filteredSummaries.filter(isLiveOrUpcoming);
  // completed（配信終了）や live 情報なし（通常動画）は recentVideos にまとめる
  const recentVideos = filteredSummaries.filter((v) => !isLiveOrUpcoming(v));

  return {
    channelId,
    liveVideos,
    recentVideos,
  };
}

// アップロード（playlistItems.list）でID収集 → videos.list(snippet,liveStreamingDetails)でlive状態付与
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

  // 1) uploadsプレイリストから直近の動画候補を取得
  const data = await youtubeApiFetch<YouTubePlaylistItemsResponse>(
    "playlistItems",
    apiKey,
    {
      part: "snippet",
      playlistId,
      maxResults: String(maxResults),
    }
  );

  const items = data.items ?? [];
  const publishedAfterTime = new Date(publishedAfter).getTime();

  // playlistItems から videoId と暫定 snippet を抽出
  const prelim = items
    .map((item) => {
      const s = item.snippet;
      const videoId = s?.resourceId?.videoId;
      if (!videoId || !s) return undefined;
      return {
        videoId,
        snippet: {
          title: s.title,
          description: s.description ?? "",
          publishedAt: s.publishedAt ?? new Date().toISOString(),
          channelTitle: s.channelTitle ?? "",
          thumbnails: s.thumbnails,
        },
      };
    })
    .filter(
      (
        v
      ): v is {
        videoId: string;
        snippet: {
          title: string;
          description: string;
          publishedAt: string;
          channelTitle: string;
          thumbnails: ThumbnailMap | undefined;
        };
      } => Boolean(v)
    );

  // 2) publishedAfter で絞り込み
  const recent = prelim.filter(
    (v) => new Date(v.snippet.publishedAt).getTime() >= publishedAfterTime
  );
  if (recent.length === 0) {
    return [];
  }

  // 3) videos.list で liveStreamingDetails/snippet を取得して live or upcoming を判定
  const ids = recent.map((v) => v.videoId);
  const videosData = await youtubeApiFetch<YouTubeVideosResponse>(
    "videos",
    apiKey,
    {
      part: "snippet,liveStreamingDetails,statistics",
      id: ids.join(","),
    }
  );

  const detailMap = new Map<string, YouTubeVideoItem>();
  for (const item of videosData.items ?? []) {
    if (item.id) {
      detailMap.set(item.id, item);
    }
  }

  // 4) buildVideoSummary で liveStreaming を付与した形に正規化
  const summaries = ids
    .map((id) => {
      const detail = detailMap.get(id);
      const snippet =
        detail?.snippet ?? recent.find((r) => r.videoId === id)?.snippet;
      return buildVideoSummary(
        id,
        snippet as {
          title: string;
          description: string;
          publishedAt: string;
          channelTitle: string;
          thumbnails: ThumbnailMap | undefined;
          liveBroadcastContent?: string;
        },
        detail?.liveStreamingDetails,
        detail?.statistics
      );
    })
    .filter((v): v is VideoSummary => Boolean(v));

  return summaries;
}

async function fetchUploadsPlaylistMap(
  channelIds: string[],
  apiKey: string
): Promise<Map<string, string>> {
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
    }
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
  params: Record<string, string>
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
    throw new Error(
      `YouTube API error (${response.status}): ${await response.text()}`
    );
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
  statistics?: YouTubeVideoStatistics
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

  if (statistics?.viewCount) {
    const parsed = Number(statistics.viewCount);
    if (Number.isFinite(parsed)) {
      summary.viewCount = parsed;
    }
  }

  const status = determineLiveStatus(snippet.liveBroadcastContent, liveDetails);
  if (status) {
    const liveStreaming: LiveStreamingInfo = {
      status,
      scheduledStartTime: liveDetails?.scheduledStartTime,
      actualStartTime: liveDetails?.actualStartTime,
      scheduledEndTime: liveDetails?.scheduledEndTime,
      actualEndTime: liveDetails?.actualEndTime,
    };

    if (liveDetails?.concurrentViewers) {
      const parsedConcurrent = Number(liveDetails.concurrentViewers);
      if (Number.isFinite(parsedConcurrent)) {
        liveStreaming.concurrentViewers = parsedConcurrent;
      }
    }

    summary.liveStreaming = liveStreaming;
  }

  return summary;
}

function determineLiveStatus(
  broadcastContent: string | undefined,
  liveDetails?: YouTubeLiveStreamingDetails
): LiveStreamingInfo["status"] | undefined {
  if (broadcastContent === "live" || broadcastContent === "upcoming") {
    return broadcastContent;
  }

  if (broadcastContent === "completed") {
    return "completed";
  }

  if (liveDetails) {
    const hasLiveTiming =
      Boolean(liveDetails.actualStartTime) ||
      Boolean(liveDetails.actualEndTime) ||
      Boolean(liveDetails.scheduledStartTime);
    if (hasLiveTiming) {
      return "completed";
    }
  }

  return undefined;
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

function toPlaylistVideoSummary(
  item: YouTubePlaylistItem
): VideoSummary | undefined {
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
  statistics?: YouTubeVideoStatistics;
}

interface YouTubeVideoStatistics {
  viewCount?: string;
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
