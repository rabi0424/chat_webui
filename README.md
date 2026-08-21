# Chat WebUI

個人用の AI チャットインターフェース。OpenRouter API 経由で複数プロバイダのモデルを単一の UI から利用できる。

詳細は [docs/requirements.md](docs/requirements.md)（要件定義書）を参照。

## 技術スタック

- React Router v8 (Framework Mode) + React 19 + TypeScript
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
| `npm run lint` | ESLint（主にフックの依存配列の検査） |
| `npm test` | テスト（vitest） |
| `npm run deploy` | ビルド + Cloudflare Workers へデプロイ |

`typecheck` は `wrangler types` を先に走らせて `Env` 型を作る。
新しくクローンしたときは `.dev.vars` を用意してからでないと、
シークレット名が `Env` に載らず型チェックが落ちることがある。

## テスト

`npm test` で走る。3層に分かれている。

- **純粋なロジック**（`tests/*.test.ts`）: 生成パラメータの組み立て、
  リトライ設定の読み取り、Markdownの分割、月間上限の判定など。Workers の
  バインディング（D1・R2）には触らない
- **DOMが要るもの**（`tests/dom/*.test.ts`）: SVGの消毒、ShadowRoot の
  貼り替えなど
- **スキーマ**（`tests/schema.test.ts`）: マイグレーションを本物の SQLite
  （`node:sqlite`）へ流し、構文・索引・流し直しの安全性を確かめる。
  壊れたマイグレーションはアプリ全体を起動不能にするため（読み書きの
  すべてが初期化を通る）
- **サーバー側**（`tests/server/*.test.ts`）: `cloudflare:workers` を
  差し替えて、バインディング（D1・R2）に触らない経路だけを動かす。
  上流へ投げた本数の数え方など、Workers の外では読めなかった部分。
  D1 や R2 に触る道は通さないこと（空の env が原因の分かりにくい失敗に
  なる。差し替えた env は触れると投げるようにしてある）
- **ビルド結果の CSS**（`tests/touch-variant.test.ts`）: クラス名を間違えても
  Tailwind は黙ってその規則を出さないだけなので、型もテストも通る。
  生成された CSS を直接見る
- **画面の操作**（`tests/dom/chat-*.test.tsx`, `tests/dom/sidebar.test.tsx`）:
  送信・編集・分岐・削除と、会話一覧の名前の変更・お気に入り・ピン留め・
  フォルダを、Testing Library で実際に操作する。通信だけを差し替え
  （`helpers/` の下）、画面側のロジック——楽観表示、IDの貼り付け、追跡、
  分岐の組み立て——は本物を動かす

テストが本当に回帰を捕まえるかは、わざとコードを壊して確かめるのが早い。
たとえば編集時の親を「ひとつ手前」から「編集対象自身」に変えると、
`chat-edit` が落ちる。落ちなければ、そのテストは素通りしている。

型チェック・ESLint・テストは GitHub Actions でも回る
（`.github/workflows/ci.yml`）。

## データの書き出し（バックアップ）

D1 の中身は手動で書き出す。

```bash
npx wrangler d1 export chat-webui --remote --output backup.sql
```

## Poeボットのパラメータを調べる

Poeのボットが受け付けるパラメータ名（画像の縦横比など）はボットごとに異なり、
モデル一覧APIには載っていない。Poeが実際に何を返しているかは次のURLで確認できる。

```
/api/poe/bot-info?bot=gpt-image-2
```

`/v1/models/<ボット名>`・`/bots/<ボット名>`・モデル一覧の該当行を順に叩き、
生のJSON（APIキーらしき値は伏せる）をそのまま返す。ここに使えそうな情報が
無い場合は、ボットのAPIページ（`poe.com/<ボット名>/api`）で名前を確認して、
⚙パネルの「ボット独自パラメータ」に入力する。
