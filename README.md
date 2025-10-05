# Cloudflare Worker for YouTube Channel Monitoring

このワークスペースは Cloudflare Workers を使って複数の YouTube チャンネルからライブ配信と直近 1 週間の動画情報をまとめて取得するための初期セットアップです。

## セットアップ

1. 依存関係をインストールします。
   ```bash
   npm install
   ```
2. Cloudflare の認証を済ませ、YouTube Data API のキーをシークレットに登録します。
   ```bash
   npx wrangler login
   npx wrangler secret put YOUTUBE_API_KEY
   ```
3. 監視対象チャンネルの ID をシークレットに設定します (カンマ区切り)。
   ```bash
   # 第1グループ (必須)
   npx wrangler secret put YOUTUBE_CHANNEL_IDS_1
   # 第2グループ (必要に応じて)
   npx wrangler secret put YOUTUBE_CHANNEL_IDS_2
   ```

## 開発

ローカルで開発サーバーを起動します。

```bash
npm run worker:dev
```

## エンドポイント

- `GET /` … 簡単な使い方のメッセージを返します。
- `GET /channels?group=1` / `?group=2` … シークレットで設定したチャンネルグループを指定して、ライブ配信と 1 週間以内に公開された動画を返します。
  - `group` パラメーターは必須です。`1` / `2` 以外を指定すると 400 が返ります。
  - ハンドルやユーザー名を `YOUTUBE_CHANNEL_IDS_*` に登録しておけば Worker 側でチャンネル ID に解決します。
  - レスポンスにはチャンネル名・サムネイル・ライブ配信のメタ情報を含む video summary が返ります。

レスポンス例:

```json
{
  "requestedAt": "2024-01-01T12:34:56.789Z",
  "channels": [
    {
      "input": "@sample",
      "channelId": "UCxxxx",
      "channelTitle": "Sample Channel",
      "channelThumbnails": {
        "default": { "url": "https://example.com/default.jpg" },
        "medium": { "url": "https://example.com/medium.jpg", "width": 320, "height": 180 },
        "high": { "url": "https://example.com/high.jpg", "width": 480, "height": 360 }
      },
      "liveVideos": [
        {
          "videoId": "live123",
          "title": "Live now",
          "description": "ライブ配信の概要",
          "publishedAt": "2024-01-01T11:00:00Z",
          "channelTitle": "Sample Channel",
          "thumbnails": {
            "default": { "url": "https://example.com/thumb-default.jpg" },
            "medium": { "url": "https://example.com/thumb-medium.jpg", "width": 320, "height": 180 },
            "high": { "url": "https://example.com/thumb-high.jpg", "width": 480, "height": 360 }
          },
          "liveStreaming": {
            "status": "live",
            "scheduledStartTime": "2024-01-01T11:00:00Z",
            "actualStartTime": "2024-01-01T11:05:00Z",
            "concurrentViewers": 1200
          }
        },
        {
          "videoId": "live124",
          "title": "Special event",
          "description": "まもなく開始予定",
          "publishedAt": "2024-01-01T09:00:00Z",
          "channelTitle": "Sample Channel",
          "thumbnails": {
            "default": { "url": "https://example.com/upcoming-default.jpg" },
            "medium": { "url": "https://example.com/upcoming-medium.jpg", "width": 320, "height": 180 },
            "high": { "url": "https://example.com/upcoming-high.jpg", "width": 480, "height": 360 }
          },
          "liveStreaming": {
            "status": "upcoming",
            "scheduledStartTime": "2024-01-01T12:00:00Z"
          }
        }
      ],
      "recentVideos": [
        {
          "videoId": "vid456",
          "title": "New video",
          "description": "動画の概要",
          "publishedAt": "2023-12-30T09:00:00Z",
          "channelTitle": "Sample Channel",
          "thumbnails": {
            "default": { "url": "https://example.com/thumb-default.jpg" },
            "medium": { "url": "https://example.com/thumb-medium.jpg", "width": 320, "height": 180 },
            "high": { "url": "https://example.com/thumb-high.jpg", "width": 480, "height": 360 }
          }
        }
      ]
    }
  ]
}
```

### レスポンスフィールド一覧

| フィールド | 種類 | 説明 |
| --- | --- | --- |
| requestedAt | string (ISO 8601) | レスポンス生成時刻 (UTC)。 |
| channels | ChannelResult[] | 取得対象チャンネルごとの情報リスト。 |
| channels[].input | string | リクエストで与えたチャンネル識別子 (ハンドル・ID・ユーザー名)。 |
| channels[].channelId | string | 正規化されたチャンネル ID (例: `UC...`)。 |
| channels[].channelTitle | string | チャンネルの表示名。 |
| channels[].channelThumbnails | object | 解像度ごとのサムネイル URL と幅/高さ。 |
| channels[].liveVideos | VideoSummary[] | 現在配信中または配信予定の動画一覧。 |
| channels[].recentVideos | VideoSummary[] | 直近 1 週間で公開された動画一覧。 |
| VideoSummary.videoId | string | YouTube 動画 ID。 |
| VideoSummary.title | string | 動画タイトル。 |
| VideoSummary.description | string | 動画の概要欄。 |
| VideoSummary.publishedAt | string (ISO 8601) | 動画の公開日時。 |
| VideoSummary.channelTitle | string | 動画に紐づくチャンネル名。 |
| VideoSummary.thumbnails | object | サムネイル解像度ごとの URL とサイズ。 |
| VideoSummary.liveStreaming | object? | ライブ配信のメタ情報。通常動画の場合は含まれない。 |
| liveStreaming.status | `live` / `upcoming` / `completed` | 配信の状態。 |
| liveStreaming.scheduledStartTime | string? | 配信予定開始時刻。`upcoming` または `live` の場合に返る。 |
| liveStreaming.actualStartTime | string? | 実際の配信開始時刻。`live` の場合に返る。 |
| liveStreaming.scheduledEndTime | string? | 配信予定終了時刻 (設定されている場合)。 |
| liveStreaming.actualEndTime | string? | 配信終了時刻。`completed` の場合に返ることがある。 |
| liveStreaming.concurrentViewers | number? | 同時視聴者数。YouTube が返した場合のみ含まれる。 |

## 自動スナップショット出力

GitHub Actions で 60 分ごとに Worker の `/channels` エンドポイントへリクエストし、レスポンスを `docs/channels1.json` / `docs/channels2.json` に保存したうえでマージ済みの `docs/channels.json` を生成し、GitHub Pages から配信できます。

1. Cloudflare 側で Worker をデプロイし、`YOUTUBE_API_KEY` や `YOUTUBE_CHANNEL_IDS_1` / `_2` など必要なバインディングを設定しておきます。
2. GitHub リポジトリの Secrets に `WORKER_ENDPOINT`（例: `https://worker.example.workers.dev/channels`）を登録します。ワークフロー側で `?group=1` / `?group=2` を自動付与します。
3. Pages のビルドソースを `docs/` ディレクトリに設定します。
4. 用意したワークフロー（`.github/workflows/generate-channels.yml`）を有効化すると、スケジュールと手動実行で 2 つの JSON とマージ済みの `channels.json` が更新されます。

生成された JSON は `https://<ユーザー名>.github.io/<リポジトリ名>/channels.json` のほか、分割された `channels1.json` / `channels2.json` から参照できます。YouTube Data API のクォータ消費は Worker が呼び出されるたびに発生するため、実行頻度には注意してください。

## デプロイ

```bash
npm run worker:deploy
```

デプロイ後は Cloudflare ダッシュボードや `wrangler routes` を使って任意のドメイン/ルートに割り当てできます。
