# Chat WebUI

個人用の AI チャットインターフェース。OpenRouter API 経由で複数プロバイダのモデルを単一の UI から利用できる。

詳細は [docs/requirements.md](docs/requirements.md)（要件定義書）を参照。

## 技術スタック

- React Router v7+ (Framework Mode) + React 19 + TypeScript
- Tailwind CSS v4
- Cloudflare Workers（ホスティング / API プロキシ）
- Cloudflare D1 / R2（永続化・添付ファイル — 後続フェーズで追加予定）

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

```bash
# 本番用シークレットの登録（初回のみ）
npx wrangler secret put OPENROUTER_API_KEY

# デプロイ
npm run deploy
```

デプロイ後は Cloudflare Access で本人のみアクセス可能にすること（要件定義書 2.2 参照）。

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー起動 |
| `npm run build` | 本番ビルド |
| `npm run typecheck` | 型チェック |
| `npm run deploy` | ビルド + Cloudflare Workers へデプロイ |
