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
3. 監視対象チャンネルの ID をシークレットに設定します (カンマ区切り)。※注意：該当チャンネルに一切動画がアップロードされていないと処理中にエラーになります。
   ```bash
   # 第1グループ (必須)
   npx wrangler secret put YOUTUBE_CHANNEL_IDS_1
   # 第2~8グループ (必要に応じて)
   npx wrangler secret put YOUTUBE_CHANNEL_IDS_N
   ```
4. プッシュ通知を利用する場合は、以下のバインディングを設定します。
   ```bash
   npx wrangler secret put CHANNELS_JSON_URL   # docs/channels.json を公開している URL
   npx wrangler secret put PUSH_TOPIC_LIVE     # LIVE 通知のトピック（例: live-stream）
   npx wrangler secret put PUSH_TOPIC_UPCOMING # ライブ予定通知のトピック
   npx wrangler secret put PUSH_TOPIC_NORMAL   # 通常動画通知のトピック
   npx wrangler secret put FCM_PROJECT_ID      # Firebase プロジェクト ID
   npx wrangler secret put FCM_CLIENT_EMAIL    # サービスアカウントの client_email
   npx wrangler secret put FCM_PRIVATE_KEY     # サービスアカウントの private_key（\n で改行を表現）
   ```

## 開発

ローカルで開発サーバーを起動します。

```bash
npm run worker:dev
```

## エンドポイント

- `GET /` … 簡単な使い方のメッセージを返します。
- `GET /channels?group=1` / `?group=2` … シークレットで設定したチャンネルグループを指定して、ライブ配信と 1 週間以内に公開された動画を返します。
  - `group` パラメーターは必須です。`1` / `2` /… / `8` 以外を指定すると 400 が返ります。
  - ハンドルやユーザー名を `YOUTUBE_CHANNEL_IDS_N` に登録しておけば Worker 側でチャンネル ID に解決します。
  - レスポンスにはチャンネル名・サムネイル・ライブ配信のメタ情報を含む video summary が返ります。
- `POST /push` … リクエストボディに通知種別などを指定して FCM にプッシュ通知を送信します。

レスポンス例:

```json
{
  "requestedAt": "2024-01-01T12:34:56.789Z",
  "channels": [
    {
      "input": "@sample",
      "channelId": "UCxxxx",
      "name": "Sample Channel,サンプルチャンネル",
      "channelTitle": "Sample Channel",
      "channelThumbnails": {
        "default": { "url": "https://example.com/default.jpg" },
        "medium": {
          "url": "https://example.com/medium.jpg",
          "width": 320,
          "height": 180
        },
        "high": {
          "url": "https://example.com/high.jpg",
          "width": 480,
          "height": 360
        }
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
            "medium": {
              "url": "https://example.com/thumb-medium.jpg",
              "width": 320,
              "height": 180
            },
            "high": {
              "url": "https://example.com/thumb-high.jpg",
              "width": 480,
              "height": 360
            }
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
            "medium": {
              "url": "https://example.com/upcoming-medium.jpg",
              "width": 320,
              "height": 180
            },
            "high": {
              "url": "https://example.com/upcoming-high.jpg",
              "width": 480,
              "height": 360
            }
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
            "medium": {
              "url": "https://example.com/thumb-medium.jpg",
              "width": 320,
              "height": 180
            },
            "high": {
              "url": "https://example.com/thumb-high.jpg",
              "width": 480,
              "height": 360
            }
          },
          "viewCount": 12345,
          "liveStreaming": {
            "status": "completed",
            "actualStartTime": "2023-12-30T08:55:00Z",
            "actualEndTime": "2023-12-30T10:05:00Z"
          }
        }
      ]
    }
  ]
}
```

### レスポンスフィールド一覧

| フィールド                       | 種類                              | 説明                                                                  |
| -------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| requestedAt                      | string (ISO 8601)                 | レスポンス生成時刻 (UTC)。                                            |
| channels                         | ChannelResult[]                   | 取得対象チャンネルごとの情報リスト。                                  |
| channels[].input                 | string                            | リクエストで与えたチャンネル識別子 (ハンドル・ID・ユーザー名)。       |
| channels[].channelId             | string                            | 正規化されたチャンネル ID (例: `UC...`)。                             |
| channels[].name                  | string?                           | `candidates-mapping.json` 由来の名前・エイリアス一覧 (カンマ区切り)。 |
| channels[].channelTitle          | string                            | チャンネルの表示名。                                                  |
| channels[].channelThumbnails     | object                            | 解像度ごとのサムネイル URL と幅/高さ。                                |
| channels[].liveVideos            | VideoSummary[]                    | 現在配信中または配信予定の動画一覧。                                  |
| channels[].recentVideos          | VideoSummary[]                    | 直近 1 週間で公開された動画一覧。                                     |
| VideoSummary.videoId             | string                            | YouTube 動画 ID。                                                     |
| VideoSummary.title               | string                            | 動画タイトル。                                                        |
| VideoSummary.description         | string                            | 動画の概要欄。                                                        |
| VideoSummary.publishedAt         | string (ISO 8601)                 | 動画の公開日時。                                                      |
| VideoSummary.channelTitle        | string                            | 動画に紐づくチャンネル名。                                            |
| VideoSummary.thumbnails          | object                            | サムネイル解像度ごとの URL とサイズ。                                 |
| VideoSummary.viewCount           | number?                           | 視聴回数。YouTube が統計情報を返した場合のみ含まれる。                |
| VideoSummary.liveStreaming       | object?                           | ライブ配信のメタ情報。通常動画でも過去のライブ配信なら含まれる。      |
| liveStreaming.status             | `live` / `upcoming` / `completed` | 配信の状態。                                                          |
| liveStreaming.scheduledStartTime | string?                           | 配信予定開始時刻。`upcoming` または `live` の場合に返る。             |
| liveStreaming.actualStartTime    | string?                           | 実際の配信開始時刻。`live` の場合に返る。                             |
| liveStreaming.scheduledEndTime   | string?                           | 配信予定終了時刻 (設定されている場合)。                               |
| liveStreaming.actualEndTime      | string?                           | 配信終了時刻。`completed` の場合に返ることがある。                    |
| liveStreaming.concurrentViewers  | number?                           | 同時視聴者数。YouTube が返した場合のみ含まれる。                      |

## プッシュ通知 `/push`

- `POST /push`
  - ボディを JSON で渡します。必須フィールドは `type`、任意で `deviceToken`（または `deviceId`）を指定できます。
  - `type` は `live` / `upcoming` / `normal` のいずれかを指定してください。
  - `deviceToken` / `deviceId` を付けると特定端末のみに配信します。省略時は環境変数で指定したトピックへ一括送信します。
  - Firebase Admin SDK のサービスアカウント（`FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY`）と `FCM_PROJECT_ID` を Worker のシークレットに登録しておく必要があります。

### リクエスト例

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"type":"live","deviceToken":"fcm-device-token"}' \
  https://worker.example.workers.dev/push
```

### 配信条件とメッセージ仕様

- **type=live**

  - 30 分間隔で呼び出し、`status=live` かつ `actualStartTime` が `requestedAt` 以降の動画に対し動画ごと 1 通送信。
  - タイトル: `🔴ライブ配信中：{チャンネル名}`
  - 本文: `{動画タイトル}` + 改行 + `通知を開いて確認する👀`
  - 画像: 対象動画のサムネイル（高解像度優先）。

- **type=upcoming**

  - 1 日 1 回（例: JST 16:30）呼び出し、`status=upcoming` かつ `scheduledStartTime` が同日 26:00 JST までの予定を抽出。
  - チャンネルごと最大 1 件、本文は開始時刻が近い順（早い順）で最大 3 件まで記載。4 件目以降は `他{N}本のライブ予定` とまとめます。
  - タイトル: `📅本日のライブ予定`
  - 本文例:
    ```
    {チャンネル名}：{LIVE配信予定時間}〜
    {チャンネル名}：{LIVE配信予定時間}〜
    {チャンネル名}：{LIVE配信予定時間}〜
    他{N}本のライブ予定
    通知を開いて確認する👀
    ```
  - 画像: 本文に掲載した 1 件目のサムネイル。

- **type=normal**
  - 1 日 1 回（例: JST 19:30）呼び出し、`liveStreaming` 情報が無い通常動画で過去 24 時間以内に公開されたものを新しい順に抽出。
  - チャンネルごと最大 1 件、本文は最大 3 件まで。4 件目以降は `他{N}本の動画` とまとめます。
  - タイトル: `🆕24時間以内の新着動画`
  - 本文例:
    ```
    {チャンネル名}：{動画タイトル}
    {チャンネル名}：{動画タイトル}
    {チャンネル名}：{動画タイトル}
    他{N}本の動画
    通知を開いて確認する👀
    ```
  - 画像: 本文に掲載した 1 件目のサムネイル。

### レスポンス例

```json
{
  "type": "upcoming",
  "requestedAt": "2024-01-01T12:34:56.789Z",
  "target": "topic",
  "targetId": "/topics/upcoming-stream",
  "sent": [
    { "channelId": "UCxxxx", "videoId": "vid123" },
    { "channelId": "UCyyyy", "videoId": "vid456" }
  ],
  "skipped": "Truncated 1 additional items"
}
```

対象が無かった場合は `sent` が空配列になり、理由が `skipped` に記載されます。`type=live` の場合は動画ごとに送信するため、失敗したものがあると `errors` 配列で個別に確認できます。

## プッシュ通知の GitHub Actions

- `.github/workflows/push-live.yml` … 30 分間隔で `type=live` を実行します。
- `.github/workflows/push-upcoming.yml` … JST 16:30 に `type=upcoming` を実行します。
- `.github/workflows/push-normal.yml` … JST 19:30 に `type=normal` を実行します。

共通で以下のシークレット/環境変数を準備してください。

- `PUSH_ENDPOINT` … Worker の `/push` エンドポイント URL（例: `https://worker.example.workers.dev/push`）。
- `PUSH_DEVICE_TOKEN_*` … 任意。特定端末のみへ送信したい場合に `PUSH_DEVICE_TOKEN_LIVE` / `_UPCOMING` / `_NORMAL` を設定します。

各ワークフローは `curl` のレスポンス本文を出力するので、GitHub Actions のログから送信結果を確認できます。

## 自動スナップショット出力

GitHub Actions で 60 分ごとに Worker の `/channels` エンドポイントへリクエストし、レスポンスを `docs/channels1.json` 〜 `docs/channels8.json` に保存したうえで、全チャンネル分をまとめた `docs/merge.json` を作成し、さらに `docs/candidates-mapping.json` と統合して `docs/channels.json` を生成し GitHub Pages から配信できます。

1. Cloudflare 側で Worker をデプロイし、`YOUTUBE_API_KEY` や `YOUTUBE_CHANNEL_IDS_1` / `_2` など必要なバインディングを設定しておきます。
2. GitHub リポジトリの Secrets に `CHANNELS_ENDPOINT`（例: `https://worker.example.workers.dev/channels`）を登録します。ワークフロー側で `?group=1` / `?group=2` /… /`?group=8` を自動付与します。※注意：該当チャンネルに一切動画がアップロードされていないと処理中にエラーになります。
3. Pages のビルドソースを `docs/` ディレクトリに設定します。
4. 用意したワークフロー（`.github/workflows/generate-channels.yml`）を有効化すると、スケジュールと手動実行で分割出力（`channels1.json` 〜 `channels8.json`）、マージ済みの `merge.json`、そして `candidates-mapping.json` を元にした最終出力 `channels.json` が更新されます。

`docs/candidates-mapping.json` の `channels[].channelId` と `merge.json` の `channelId` を突き合わせ、名前やエイリアスなどのメタデータを付加したうえで `channels.json` を生成します。新しいチャンネルを追加する場合は、Worker のシークレット設定に加えてこのマッピングファイルにもエントリを追加してください。

生成された JSON は `https://<ユーザー名>.github.io/<リポジトリ名>/channels.json`（マッピング適用済み）・分割された `channels1.json` 〜 `channels8.json` から確認できます。YouTube Data API のクォータ消費は Worker が呼び出されるたびに発生するため、実行頻度には注意してください。

## デプロイ

```bash
npm run worker:deploy
```

デプロイ後は Cloudflare ダッシュボードや `wrangler routes` を使って任意のドメイン/ルートに割り当てできます。
