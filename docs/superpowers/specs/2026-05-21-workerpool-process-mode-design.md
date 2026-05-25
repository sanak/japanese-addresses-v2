# 04_make_chiban を workerpool の process モードで並列化する設計

- 作成日: 2026-05-21
- 対象ブランチ: `chiban-workerpool-process-mode`（ベース: `18-optimize-chiban-performance`）
- ステータス: ドラフト

## 背景

`src/processes/04_make_chiban.ts` には、コミット `aeb0ac8` で導入された Promise.race ベースの市区町村並列処理がある（`CHIBAN_CONCURRENCY` 環境変数で同時実行数を制御、デフォルト 4）。これは「ある market の I/O 待ち中に別 market の処理を進める」という意味での並列化であり、Node.js のシングルスレッド event loop 上に乗っている。CSV パース・`proj4` による投影・Map マージといった CPU バウンド処理は依然として 1 コアに直列化される。

本ドキュメントは、`workerpool` ライブラリの **process モード**（`child_process.fork()` を内部で使う真の並列）を使った場合に、どの程度の高速化と引き換えにどのような変更が必要かを把握するための設計をまとめる。

## ゴール / 非ゴール

### ゴール

- `04_make_chiban` の市区町村ループを、workerpool process モードでも実行可能にする
- 既存の Promise.race 版と並存させ、`CHIBAN_PARALLEL` env で切り替え可能にする
- 同じ入力で両実装が出力ファイル群を**バイナリ一致**で生成することを担保する
- 京都府などの中規模スコープで wall time / CPU 利用率 / メモリを比較計測できるようにする

### 非ゴール

- 03_make_rsdt の並列化（今回は触らない）
- worker_threads を使った別実装の検証（今回は process モードのみ）
- pino 等のロギング基盤の刷新

## 採用アプローチ

`04_make_chiban.ts` の main 関数内で `CHIBAN_PARALLEL` を見て、`runCitiesWithPromiseRace()` か `runCitiesWithWorkerpool()` を呼び分ける（**アプローチ A**）。共通ロジック（`processCity`, `serializeApiDataTxt`, `outputChibanData` および関連型）は `04_make_chiban_lib.ts` に切り出して main / worker 双方から import する。

Strategy パターン（lib/parallel.ts での抽象化）は YAGNI のため見送る。別ファイルでの並置は共通ロジックの重複を生むため見送る。

## アーキテクチャ

```
┌──────────────────────────────────────────────────────────────┐
│ Main process (04_make_chiban.ts)                             │
│                                                              │
│  1. machiAzaData をロード                                    │
│  2. CHIBAN_PARALLEL 判定                                     │
│     ├── 'workerpool' → workerpool.pool(...) 経由             │
│     └── それ以外     → 既存の Promise.race 経由              │
│  3. main は machiAzaResult.properties.id だけを worker に渡す│
│  4. cliProgress.SingleBar は main 側で進捗管理               │
└──────────────────┬───────────────────────────────────────────┘
                   │ pool.exec('processCity', [args])
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Worker process (04_make_chiban_worker.ts) × N                │
│  - workerpool.worker({ processCity })                        │
│  - 初回タスクで machiAzaResultId から CSV をストリーム読込   │
│    し、lg_code → MachiAzaData[] の Map をモジュールスコープ │
│    にキャッシュ                                              │
│  - 該当 lg_code 分だけ Map を組み立てて processCity 本体実行 │
│  - 出力ファイルは worker が直接書き込む                      │
└──────────────────────────────────────────────────────────────┘
```

ポイント:

- 並列対象は市区町村ループのみ。事前準備（町字マスター取得）は main で 1 回だけ
- worker は出力ファイルを直接書き込み、戻り値で巨大バッファを返さない
- worker 数は `CHIBAN_CONCURRENCY` env をそのまま流用（既存挙動と対称）
- 既存のディスクキャッシュ（`cache/hub/`）は worker からも参照可能。再ダウンロードは発生しない

## コンポーネント構成

### 新規ファイル

| ファイル | 役割 |
|---|---|
| `src/processes/04_make_chiban_lib.ts` | `processCity`, `serializeApiDataTxt`, `outputChibanData`, 型 (`ChibanApi`, `HeaderRow`) を export。main / worker 両方から import |
| `src/processes/04_make_chiban_worker.ts` | workerpool worker entry。`workerpool.worker({ processCity })` を呼ぶ薄いラッパ |

### 修正ファイル

| ファイル | 変更内容 |
|---|---|
| `src/processes/04_make_chiban.ts` | `processCity` 等のローカル定義を削除し `_lib` から import。`main()` に env 分岐を追加。`runCitiesWithPromiseRace()` / `runCitiesWithWorkerpool()` の 2 ヘルパに整理 |
| `package.json` | `devDependencies` に `workerpool` を追加。`run:04_make_chiban:pool` スクリプトを追加 |

### 依存ライブラリ

- `workerpool` v9.x 系を想定（process モード対応版）
- 既存の `tsx` / `cli-progress` はそのまま流用

### 環境変数

| 変数 | 既存/新規 | 用途 |
|---|---|---|
| `CHIBAN_CONCURRENCY` | 既存 | 並列数（Promise.race / workerpool 共通） |
| `CHIBAN_PARALLEL` | 新規 | `workerpool` を指定すると process プール経由。それ以外（未設定含む）は既存の Promise.race |

### npm スクリプト

- `run:04_make_chiban` は据え置き（互換性維持）
- 比較用に `run:04_make_chiban:pool` を新設

```json
"run:04_make_chiban:pool": "CHIBAN_PARALLEL=workerpool node --max-old-space-size=8192 --import tsx ./src/04_make_chiban.ts"
```

## データフロー

### main → worker（タスク投入）

```ts
type ProcessCityArgs = {
  ma: MachiAzaData;          // 代表エントリ
  machiAzaResultId: string;  // hub.ts のキャッシュ ID。worker が CSV を読むのに使う
  outDir: string;
};
```

IPC ペイロードはこのオブジェクトのみで、JSON 化しても数十バイト程度。

### worker（モジュールスコープのキャッシュ）

```ts
let machiAzaByLgCode: Map<string, MachiAzaData[]> | undefined;

async function loadMachiAzaIndex(id: string) {
  if (machiAzaByLgCode) return machiAzaByLgCode;
  const stream = getAndStreamCSVDataForId<MachiAzaData>(id);
  const index = new Map<string, MachiAzaData[]>();
  for await (const row of stream) {
    const list = index.get(row.lg_code) ?? [];
    list.push(row);
    index.set(row.lg_code, list);
  }
  machiAzaByLgCode = index;
  return index;
}

export async function processCity(args: ProcessCityArgs) {
  const index = await loadMachiAzaIndex(args.machiAzaResultId);
  const entries = index.get(args.ma.lg_code) ?? [];
  const machiAzaDataByCode = new Map(
    entries.map(ma => [`${ma.lg_code}|${ma.machiaza_id}`, ma]),
  );
  // 既存の processCity 本体（_lib に同居）を呼ぶ
}
```

- 初回タスクで全国 CSV を 1 回スキャン（worker あたり 1〜2 秒程度の想定）
- 2 回目以降のタスクはキャッシュから lg_code 分だけ取り出す
- worker × 全国 Map のメモリは 80–200MB 程度（8GB heap 内で十分許容）

### worker → main（結果通知）

```ts
type ProcessCityResult = {
  outFilename: string;
  count: number;
};
```

戻り値は小さなオブジェクトのみ。失敗時は `pool.exec` が reject するため、main で個別に catch してログ出力して続行する。

### キャッシュとファイル I/O

- `cache/hub/` 配下のディスクキャッシュは worker からも参照可能
- 出力先 `out/api/ja/<pref>/<city>-地番.txt` は city ごとにユニークなので書き込み競合は発生しない
- `fs.promises.mkdir({ recursive: true })` で `pref` ディレクトリ作成の並行競合を吸収

## エラー処理

| 失敗ケース | 対応 |
|---|---|
| 該当データが Hub に無い（`Insufficient data found`） | worker 内で `console.error` してその city を skip、他は継続（既存挙動と同じ） |
| CSV 取得失敗（ネットワーク等） | `fetch_with_retry` で 3 回リトライ。最終失敗時は exec が reject |
| `processCity` 内の予期せぬ例外 | exec が reject。main で個別 catch して `console.error` して継続 |
| worker プロセスのクラッシュ／OOM | workerpool が新 worker を再起動。当該タスクは reject。main は他 city への波及を防ぎ続行 |
| `SIGINT` 等での中断 | main の `finally` で `await pool.terminate({ force: true })`。プロセスリーク防止 |

### main 側の実装イメージ

```ts
async function runCitiesWithWorkerpool(
  machiAzas: MachiAzaData[],
  machiAzaResultId: string,
  outDir: string,
  progress: cliProgress.SingleBar,
) {
  const pool = workerpool.pool(
    path.join(import.meta.dirname, '04_make_chiban_worker.ts'),
    {
      workerType: 'process',
      maxWorkers: CONCURRENCY,
      forkOpts: { execArgv: ['--import', 'tsx'] },
    },
  );
  try {
    await Promise.all(machiAzas.map(async (ma) => {
      try {
        await pool.exec('processCity', [{ ma, machiAzaResultId, outDir }]);
      } catch (err) {
        console.error(
          `Failed to process ${ma.pref} ${ma.county}${ma.city}${ma.ward}:`,
          err,
        );
      } finally {
        progress.increment();
      }
    }));
  } finally {
    await pool.terminate({ force: true });
  }
}
```

## テスト & 検証方針

### 1. ユニットテスト

`04_make_chiban_lib.ts` の純粋関数のみテスト対象とする。並列化機構自体（workerpool 挙動）はライブラリ側の責務なのでテスト不要。

| 対象 | テスト内容 |
|---|---|
| `serializeApiDataTxt` | 空入力、1 町字、複数町字、ヘッダ拡張（>50KB）パスを通すケース |

`processCity` 本体は I/O が深く絡むため、ユニットテストでカバーするより同値性テストで担保する。

### 2. 同値性テスト（最重要）

新ブランチでの正しさは「既存実装と同じ出力」を出すことで証明する。

```bash
# 1. 既存 Promise.race 版で出力
rm -rf out/api && CHIBAN_PARALLEL= npm run run:04_make_chiban
shasum -a 256 out/api/ja/**/*-地番.txt | sort > /tmp/baseline.sha256

# 2. workerpool 版で出力
rm -rf out/api && npm run run:04_make_chiban:pool
shasum -a 256 out/api/ja/**/*-地番.txt | sort > /tmp/workerpool.sha256

# 3. 差分ゼロを確認
diff /tmp/baseline.sha256 /tmp/workerpool.sha256
```

事前条件: 02 まで実行済みで `cache/` も同一状態。

### 3. ベンチマーク

中規模スコープ（京都府 = `^26`）で計測:

```bash
time SETTINGS_JSON='{"lgCodes":["^26"]}' npm run run:04_make_chiban
time SETTINGS_JSON='{"lgCodes":["^26"]}' npm run run:04_make_chiban:pool
```

並列数の探索:

```bash
for n in 1 2 4 8; do
  CHIBAN_CONCURRENCY=$n npm run run:04_make_chiban:pool 2>&1 | tail -3
done
```

得たい指標:

- **wall time**（pipeline 全体）
- **CPU 利用率**（多コア張り付きを確認）
- **メモリ最大値**（`/usr/bin/time -l` の `maximum resident set size`）

期待する観察:

- Promise.race 版は CPU 1 コアに張り付く（CSV パースと proj4 投影が直列）
- workerpool 版は N コア張り付き、wall time は理論上 1/N に近づくが、起動コスト + IPC で N=4 で 2.5〜3 倍程度の高速化が現実的な目安
- メモリは workerpool 版がやや増（worker × 全国 Map）

### 4. 静的検証

```bash
npm run build:dev   # tsc が新規ファイルもコンパイル
npm run lint        # eslint
npm test            # 既存テストが壊れていないこと（既存の 02 失敗は別件として除外）
```

### 5. マニュアル検証チェックリスト

- [ ] `CHIBAN_PARALLEL` 未指定で既存挙動と同一
- [ ] `CHIBAN_PARALLEL=workerpool` で worker プロセスが N 個立つ（`ps -ef | grep node` で確認）
- [ ] 中断（Ctrl-C）後、孤立した node プロセスが残らない
- [ ] 出力ファイルのバイナリ同一性（2.）
- [ ] tsx loader が worker でも有効（worker file が `.ts` のまま起動できる）

## 既知のリスクと前提

- **既存のテスト失敗**: `02_make_machi_aza.test.ts` の宮崎県えびの市ケースが本作業開始時点で失敗している。これは ABR データ更新由来の別件で、本スコープ外。本作業後にもこの 1 件の状態が変化しないことを最終確認する
- **workerpool のバージョン**: `workerType: 'process'` および `forkOpts` API は v6.x 以降の安定機能。v9.x 系の使用を前提とする
- **tsx + ESM の worker 起動**: `forkOpts.execArgv: ['--import', 'tsx']` で動くことを動作確認する。動かなければ pre-compile した `.js` を呼ぶフォールバックを検討する

## ロールアウト方針

1. 新ブランチで実装
2. 京都府スコープで同値性 + ベンチマーク
3. 結果が良好かつ同値であれば、PR を作成し人間レビューを受ける
4. 本番採用の判断はベンチマーク結果と人間レビューの両方を経た後

## 検証結果（2026-05-21 京都府スコープ）

- 対象: `SETTINGS_JSON='{"lgCodes":["^26"]}'`（京都府全 36 市区町村）
- 並列数: `CHIBAN_CONCURRENCY=4`（デフォルト）
- 同値性: **PASS**
- baseline ファイル数: 36
- workerpool ファイル数: 36
- sha256 一致率: 100%（diff 出力なし）

`out/api_baseline/ja/京都府/*-地番.txt` と `out/api_workerpool/ja/京都府/*-地番.txt` を sha256 で比較した結果、全 36 ファイルがバイト単位で完全一致した。workerpool process モード実装は既存 Promise.race 実装と挙動同値であることを確認。

### ベンチマーク（京都府、`/usr/bin/time -l`）

実行環境: macOS（Darwin 25.5.0）、Node.js 22、cache 温まり状態。

| 実装 | N | wall (real) | user | sys | maximum RSS |
|---|---|---|---|---|---|
| Promise.race | 4 | 39.08 s | 42.62 s | 1.35 s | 1,452 MB |
| workerpool | 1 | 45.09 s | 49.49 s | 1.22 s | 1,255 MB |
| workerpool | 2 | 31.02 s | 59.73 s | 2.19 s | 1,180 MB |
| workerpool | 4 | **24.49 s** | 79.37 s | 4.54 s | 1,172 MB |
| workerpool | 8 | 24.11 s | 119.92 s | 12.94 s | 1,078 MB |

考察:

- **wall time**: workerpool N=4 が Promise.race N=4 に対して **約 1.60x 高速**（39.08 → 24.49 秒）。CPU 並列化の効果が出ている
- **スケーラビリティ**: N=4 と N=8 で wall time がほぼ同じ（24.49 vs 24.11 秒）。京都府スコープでは N=4 で CPU を頭打ち。N=8 では sys time が約 3 倍（4.54 → 12.94 秒）に増え、コンテキストスイッチのコストが目立つ
- **メモリ**: workerpool 版の方が **maximum RSS が低い**（1,078-1,255 MB vs 1,452 MB）。これは当初予想と逆だった。理由は、各 worker が lg_code 単位の部分 Map しか保持しないのに対し、Promise.race 版では main プロセス内で並行実行中の全 city の中間状態（CSV ストリーム、Map、累積 chiban リスト等）が同時に滞留するため。worker 分離による「メモリ局所化」の効果が大きい
- **起動コスト**: workerpool N=1 が Promise.race N=4 より遅い（45.09 vs 39.08 秒）のは想定通り。worker プロセスの fork + tsx 初期化 + IPC のオーバーヘッドが、並列化の利益が無い N=1 では純粋なコストとして見える
- **CPU 効率**: user time の伸び方は N=1→2 で +20%、N=2→4 で +33%、N=4→8 で +51%。N が増えるほど IPC や tsx 初期化のオーバーヘッドが効いてくる

### 採用判断のヒント

- 全国スコープ（~1,700 市区町村）でも同様の傾向なら、wall time は workerpool N=4 で 1.5〜2x 短縮できる見込み
- メモリ削減効果は実用上の追加価値。8GB heap 制限を超えそうな全国実行で安全側に振れる
- 並列数は **N=4 が現実的な最適点**。N=8 にしても効果薄、N=2 だと半端
- Promise.race 実装も残しておくと、再現可能性検証や CI 軽量化のためのフォールバックとして使える
