# Codex のエージェント運用

このリポジトリでは `.github/agents/*.agent.md` を Copilot と Codex で共有する役割定義の正本とする。Codex は以下の対応表から必要なファイルを読み、その本文の役割・手順・制約に従う。対応表の要約だけで作業しない。

## 役割の選択

ユーザーが役割名を指定したら、その定義を読み込んで担当する。役割が指定されていない場合は依頼に合う役割を選ぶ。アプリケーションの計画から実装・レビュー・テストまでの一連の変更には統括担当を使う。説明のみの依頼やエージェント設定・ドキュメントのみの変更に、アプリケーションの全工程を適用する必要はない。

| 役割名 | 定義ファイル | 用途 |
| --- | --- | --- |
| `aplication_orchestrator` | `.github/agents/aplication_orchestrator.agent.md` | 計画・実装・レビュー・テストの統括 |
| `application_planner` | `.github/agents/application_planner.agent.md` | 要件とサンプルを調査して計画を作成 |
| `application_coder` | `.github/agents/application_coder.agent.md` | 承認済みの変更を実装 |
| `application_reviewer` | `.github/agents/application_reviewer.agent.md` | 差分・回帰・テスト不足のレビュー |
| `application_tester` | `.github/agents/application_tester.agent.md` | 承認済みのテスト・PC ブラウザ確認 |
| `response_analyzer` | `.github/agents/response_analyzer.agent.md` | 指定した 2 つのサンプル JSON の構造比較 |
| `sample_update` | `.github/agents/sample_update.agent.md` | 指定スクリプトで API サンプルを更新 |

`application_orchestrator` は既存名 `aplication_orchestrator` の別名として同じファイルを参照する。

## Copilot 定義を Codex で解釈するルール

- YAML の `name`、`description`、`tools`、`agents`、`user-invocable` は Copilot 用のメタデータ。Codex の設定やツール登録として実行せず、本文の指示を適用する。
- 統括担当のファイルは YAML 区切りがなく、実行フローが重複している。冒頭のメタデータを本文と区別し、重複する同じフローは 1 回分として扱う。
- `read` / `search` / `edit` / `execute` は、そのセッションで利用可能なファイル読み取り・検索・編集・コマンド実行ツールに読み替える。読み取り専用の役割はファイルを変更しない。メタデータのツール一覧は Codex の権限を拡張しない。
- 統括担当で作業する場合は、サブエージェント機能が利用可能なら各フェーズを該当する役割のサブエージェントに委譲する。委譲時は、定義ファイルを読む指示、対象、要件、承認済みの範囲、期待する成果物を渡す。依存するフェーズは前の結果を待って順番に進め、レビューや承認を飛ばさない。
- サブエージェント機能が利用できなければ、主エージェントが役割を順番に切り替えて同じ工程を実施し、その旨を伝える。起動していないサブエージェントを起動済みと報告しない。
- 定義はシステム・開発者指示とユーザーの現在の依頼に従う範囲で適用する。すでに得た承認は対象範囲を確認して引き継ぎ、同じ承認を再要求しない。

## 承認と検証

- 統括担当の計画・実装の承認ゲートと、テスト担当の明示承認ゲートを維持する。テスト担当のゲートは coder や reviewer に実行を移すことで回避しない。
- `npm test`、ビルド、開発サーバー起動、Playwright、ゲーム API へのアクセスは、実行内容についてユーザーの明示承認がある範囲で行う。承認が必要な場合は、コマンド・対象 URL・API アクセスの可能性を具体的に示す。
- サンプル更新は `sample_update` の定義に従い、`npm run sample:update` を使う。Windows で必要なら同じ npm スクリプトを `npm.cmd run sample:update` で実行する。
- `sample/` は Git 管理対象外なので、手元に必要な JSON があるか確認する。不足している場合はその事実を報告し、未承認の API 取得で補わない。
- 完了時は変更内容、実際に行った検証、未実行の検証と理由を区別して報告する。
