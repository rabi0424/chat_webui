import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * 主目的はフックの依存配列の検査。
 *
 * コード中に `eslint-disable-next-line react-hooks/exhaustive-deps` が
 * 点在していたが、ESLint 自体が入っていなかったため、その指定は何も
 * 抑制しておらず、検査も走っていなかった。ここで実際に動かす。
 *
 * 書式や好みの規則は入れない。既存のコードを大きく書き換えることに
 * なるうえ、いま欲しいのは「壊れやすい書き方に気づく」ことだけなので。
 */
export default tseslint.config(
  {
    ignores: [
      "build/**",
      ".react-router/**",
      "worker-configuration.d.ts",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 意図的に無視している依存は個別のコメントで抑制する
      "react-hooks/exhaustive-deps": "warn",
      // catch した値を使わない書き方（握りつぶし）は意図的に多用している
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      /*
       * 日本語の検索語を全角スペースでも切るため、文字クラスに U+3000 を
       * 直接書いている。文字列と正規表現の中は見なくてよい。
       */
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipRegExps: true, skipTemplates: true },
      ],
      /*
       * 以下は「直すには構造から変える必要がある」もので、監査で
       * 把握済みの課題（Chat.tsx と Sidebar.tsx の分割）に相当する。
       * 見えなくすると忘れるので消さず、取り込みは止めない警告にする。
       *
       * - set-state-in-effect: 効果の中で状態を直接更新している箇所
       * - refs: 描画中に ref を書いている箇所
       * - static-components: 関数の内側で定義しているコンポーネント
       *   （毎回別物になるので、その部分が作り直される）
       */
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
    },
  },
);
