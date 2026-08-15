# Chat WebUI

個人用の AI チャットインターフェース。OpenRouter API 経由で複数プロバイダのモデルを単一の UI から利用できる。

詳細は [docs/requirements.md](docs/requirements.md)（要件定義書）を参照。

## 技術スタック

- React Router v7+ (Framework Mode) + React 19 + TypeScript
- Tailwind CSS v4
- Cloudflare Workers（ホスティング / API プロキシ）
- Cloudflare D1（会話・メッセージの永続化）/ R2（添付画像）

## 開発環境のセットアップ

```bash
npm install

# APIキーの設定（.dev.vars は gitignore 済み）
cp .dev.vars.example .dev.vars
# .dev.vars を編集して OpenRouter の API キーを設定

# 開発サーバー起動 → http://localhost:5173
npm run dev
```

## デプロイ（Cloudflare Workers）

初回のみ、以下のセットアップが必要:

1. **D1データベースの作成**: Cloudflareダッシュボード → Storage & Databases → D1 →
   Create Database（名前: `chat-webui`）。作成後に表示される **Database ID** を
   `wrangler.jsonc` の `database_id` に設定する。
   テーブルは初回アクセス時に自動作成される（マイグレーションコマンド不要）。
2. **R2バケットの作成**: ダッシュボード → R2 → Create bucket（名前: `chat-webui-file`）。
   添付画像の保存先で、`wrangler.jsonc` の `FILES` バインディングが参照する。
   未作成のままでも画像添付以外の機能は動作する（添付時にエラーを表示）。
3. **シークレットの登録**: ダッシュボードのWorker設定（Variables and Secrets）で
   `OPENROUTER_API_KEY` を設定、または `npx wrangler secret put OPENROUTER_API_KEY`。

デプロイはGitHub連携（mainブランチへのpushで自動デプロイ）、
または手動で `npm run deploy`。

デプロイ後は Cloudflare Access で本人のみアクセス可能にすること（要件定義書 2.2 参照）。

## ホーム画面に追加（PWA）

iPhone の Safari で共有メニュー →「ホーム画面に追加」すると、
ブラウザのUIなしのアプリ風全画面（ステータスバー背後まで描画）で起動できる。
オフライン動作は要件外のため Service Worker は持たない（ネットワーク必須）。

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー起動 |
| `npm run build` | 本番ビルド |
| `npm run typecheck` | 型チェック |
| `npm run deploy` | ビルド + Cloudflare Workers へデプロイ |
