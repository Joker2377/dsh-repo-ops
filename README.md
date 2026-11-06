# dsh-repo-ops

把 git 與 GitHub 的日常工作包成九個結構化工具，讓 agent 用一次呼叫就知道「我在哪裡、改了什麼、PR 與 CI 現在怎樣」，而不是連續跑十條 shell 指令再自己解析輸出。


## 功能

| 工具 | 做什麼 | 讀寫 |
|---|---|---|
| `repo_status` | branch、HEAD、ahead/behind、未提交檔案、預設分支，外加這個分支目前的 PR 與 CI 摘要 | 唯讀 |
| `repo_diff` | 改了哪些檔（+/-）、diff 原文、commit 清單、單一 commit 的內容 | 唯讀 |
| `repo_commit` | stage 指定檔案並 commit，支援 amend 與 undo（soft reset） | 寫入 |
| `repo_push` | 推分支，回傳推前/推後的 sha 與遠端回應（含 GitHub 給的 PR 網址） | 寫入 |
| `repo_branch` | 分支清單與各自 ahead/behind、開、切、刪、fetch、pull、與 base 同步 | 寫入 |
| `repo_pr` | PR 的 status / list / view / create / update / comment / reply / diff / checkout / ready / merge | 混合 |
| `repo_ci` | GitHub Actions 的 status / list / view / logs / watch / rerun / workflow | 混合 |
| `repo_issue` | issue 的 list / view / create / comment / close / reopen | 混合 |
| `repo_release` | release 與 tag 的 list / view / create / edit / delete / tags | 混合 |

三個設計取向決定了它長這樣：

1. **一個工具一類工作，不是一個子指令一個工具。** 九個工具各有 action，而不是四十個包著每個 git 子指令的工具，也不是單一 mega-tool 帶一個四十個值的 enum。
2. **破壞性動作要 `confirm:true`。** 裸 `--force` 推送、刪未合併分支、合併 PR、重跑 workflow、觸發 workflow_dispatch、刪 release，在 `confirm` 不為 true 時一律「只回傳會跑的這一行，但不執行」。工具不会静默動遠端。
3. **沒有 `--no-verify`。** pre-commit 與 pre-push hook 照跑，這是刻意的。

## 安裝

需要本機有 `git`（實測 2.51.0）與 `gh`（實測 2.92.0，且已 `gh auth login`）。兩者預設走 PATH；找不到時可在設定裡給絕對路徑。

安裝是把 **repo 首頁**交給 plugin_manager（不是 tarball 網址）：請 agent 用 `plugin_manager` 安裝 `github:Joker2377/dsh-repo-ops`，或直接指定 release 裡的 tarball，裝完重載 profile。

repo 首頁：https://github.com/Joker2377/dsh-repo-ops

要在 cordis.patch.yml 手動掛載：

```yaml
- insert:
    - id: repo-ops
      name: dsh-repo-ops
      config: {}
```

可用的 config 鍵（定義在 lib/index.js 的 Config）：

| 鍵 | 預設 | 意義 |
|---|---|---|
| `ghPath` | 空字串 | `gh` 不在 PATH 時的絕對路徑，例 `C:/Program Files/GitHub CLI/gh.exe` |
| `gitPath` | 空字串 | 同上，給 `git` |
| `timeoutMs` | 60000 | 一條指令的最長執行時間 |
| `watchTimeoutMs` | 300000 | `repo_ci` 的 watch 預設等待上限 |
| `readOnly` | false | true 時所有寫入 action 直接拒絕，只准查詢 |

## 使用

工具是给 agent 用的，典型一輪是這樣：

```text
repo_status()                      -> branch=feat/login，+2/-0，3 個未提交檔，PR #41 open，checks: 1 FAIL
repo_diff(action=files)            -> lib/auth.ts +12 -3 …
repo_commit(paths=["lib/auth.ts"], message="fix: reject empty token")
repo_push()                        -> 8f2a1c9 -> 41b7d02，遠端回應裡帶著 PR #41 的網址
repo_ci(action=watch, runId=12345) -> completed / failure（等了 74s）
repo_ci(action=logs, runId=12345)  -> 失敗 job 的 log 尾端 200 行
repo_pr(action=view)               -> 含未結的 review 執行緒，要回話用的 commentId 就在裡面
```

幾個要記住的參數語意：

- `path`：repo 內**任何**目錄的絕對路徑，會自動上溯到 repo 根；不給就用這個 session 的工作目錄（不是 host 程序的 cwd）。
- `repo`：`owner/name` 或完整 GitHub URL，直接進 gh 的 `--repo`。不給時由本機 git remote 推得。
- `confirm:true`：只對破壞性 action 有意義，語意是「我已經跟使用者確認過了」，不是「先試試看」。
- 多行的 `message` / `body` 會被當成**單一參數**傳給 CLI，不經 shell，所以引號、換行、美元符號都不會出錯。

## 疑難排解

**回報找不到 gh** — 先確認本機 `gh --version` 跑得到。若 DSH 桌面版的啟動環境 PATH 不含安裝目錄，就把絕對路徑寫進 `ghPath`；工具會列出它試過哪些位置。

**未登入 / 401 / 403** — 這是 gh 的憑證問題，工具不會代跑 `gh auth login`（那需要互動與瀏覽器）。請在本機登入一次，並確認 token 有 `repo` scope。

**repo_status 說 GitHub 那側沒回應，但 git 那側正常** — 這是刻意設計：兩側獨立，任一側壞了另一側照常回報，結尾會附一行說明哪側失敗、原因為何。

**ahead/behind 顯示 null** — 這個分支還沒有 upstream。第一次推請用 `repo_push(setUpstream:true)`。

**repo_pr(action=view) 找不到 PR** — 該分支沒有開著的 PR；改用 `repo_pr(action=list)`，或直接給 `number`。

**CI 的 watch 回報 timedOut** — 是等待到期而 run 還在跑，不是失敗。再呼叫一次 watch 就續等。

## 運作原理

```text
lib/index.js   讀 config -> 建 runner -> 建 git/github -> 在 ctx.effect 內註冊九個工具
lib/cli.js     二進位探索（設定值 -> PATH -> 常見安裝路徑）+ spawn（argv 陣列、逾時 kill、
               暫態錯誤重試、缺檔 30 秒冷卻）+ secret 遮罩
lib/git.js     只用 git 的穩定介面：--porcelain=v2、--format、for-each-ref、ls-remote
lib/github.js  gh 的 --json 為主，欄位名集中在可匯出的常數（全部扁平，理由見下），回傳前正規化成 bucket
lib/tools.js   九個 defineTool：參數表、read-only 與併行宣告、把 args 折成模組呼叫
lib/render.js  資料 -> 一行一事實的文字；缺東西時這行要順便講下一步
test/          全部注入假 runner，不碰真實 CLI 與網路
```

幾個值得知道的實作決定：

- **不走 shell。** 一律 spawn(command, argv[])，避免引號注入，也讓多行 commit message 正常傳下去。
- **二進位探索不只靠 PATH。** 從桌面版啟動時 PATH 可能不含 `C:/Program Files/GitHub CLI`，所以依序試設定值、PATH、固定安裝路徑，並帶 30 秒冷卻避免每次重探。
- **per-session 的工作目錄**取自 exec.agent.session.header.cwd。process.cwd() 是 host 的啟動目錄，對 web 部署來說是安裝目錄而不是專案目錄，因此只作最後備援。
- **ciWatch 用輪詢而非 gh run watch。** 後者會佔滿整個 timeout，也無法中途回報進度。
- **失敗一律回字串，不擲例外。** 讓模型看得到原因與下一步，比讓工具顯示成一個失敗狀態有用。
- **gh 的 --json 一律只寫扁平欄位名。** gh 不支援 `assets{name}`、`jobs{name}` 這種巢狀選欄（實測 2.92 會回 `Unknown JSON field`），所以每個常數都是頂層欄位，欄位內容由 mapper 收窄；要列附檔就是 `--json assets` 一欄拿整個物件。
- **`gh repo view` 沒有 `--repo`。** 它的對象是位置參數，所以 repoInfo 走 `gh repo view <owner/name> --json …`，其餘子命令才用 `--repo`。
- **受限沙箱裡不能開管線子程序。** 桌面沙箱會讓 `spawn` 的 piped stdio 直接 EPERM（git 自己的 sh.exe 也開不了 signal pipe），所以 lib/cli.js 失敗時改把 stdout/stderr 接到暫存檔再試一次；這條路讓測試與 smoke 在受限環境仍能跑真的 git。

## 開發

```bash
git clone https://github.com/Joker2377/dsh-repo-ops.git
cd dsh-repo-ops
npm run check          # 形狀檢查：manifest / patch / 工具面 / README 段落 / 測試是否離線
npm test               # 逐檔 import 跑完 152 個測試，不需要 npm install
npm run test:spawn     # 同一套測試改用 node --test（每檔一個子程序；受限沙箱內會 EPERM）
node scripts/smoke.mjs                 # 真的 git：在暫存 repo 上跑完讀寫流程，不碰網路
$env:SMOKE_ONLINE=1; node scripts/smoke.mjs   # 再加唯讀 gh：pr / ci list+view / issue / release / tags
node scripts/verify-gh.mjs             # 逐一打真的 gh：13 個唯讀呼叫都要拿到資料，任何一個失敗就 exit 1
```

單元測試全部注入假 runner，不碰真實 git/gh，也不碰網路，只要 Node 22+ 就能跑；smoke 才是碰真 CLI 的那一層。
scripts/check.mjs 是 CI 的第一道關卡：它檢查「裝得起來嗎」這一類會讓單元測試全綠、但安裝壞掉的問題。

### 已驗證到哪裡

| 面 | 證據 |
|---|---|
| 152 個單元／整合測試 | 假 runner；CI 矩陣 ubuntu-latest + windows-latest × node 22/24 |
| 真的 git | `node scripts/smoke.mjs`：init、status、diff、commit、branch、push 失敗訊息，全部在暫存 repo 上實際跑過 |
| 真的 gh（唯讀） | `node scripts/verify-gh.mjs` 13/13：authStatus、repoInfo、prList、prView、prChecks、ciList、ciView、ciStatus、issueList、issueView、releaseList、releaseView、workflowList 對 `Joker2377/dsh-plugin-updates` 與 `cli/cli` 實際拿到資料 |
| 寫入型 gh（create / merge / comment / rerun / release） | **未在真實 repo 上執行**：只驗到 argv 與 confirm 閘門，沒拿公開 repo 做寫入 |
| 安裝進 profile | **未安裝**：0.1.0 只到 repo 與 release 這一層 |

## 已知限制

- 需要本機 `git` 與 `gh`。這版不自帶 libgit2，也沒有內建 REST 備援通道。
- gh 只在已 `gh auth login` 的前提下工作；工具不處理裝置流程登入。
- GitHub 專屬。GitLab、Gitea 的 PR 與 CI 面不支援（git 那側走 porcelain，本來就與托管無關）。
- 不碰 git-lfs、submodule 與 worktree 建立（`create_worktree` 是 host 自己的工具），也不做互動式 rebase 流程。
- 一次只針對一個 repo；跨 repo 的工作請多次呼叫，各給自己的 path 或 repo。
- 輸出是給模型讀的紧凑文字，不是給人看的彩色報表；要做漂亮報表請用 host 的 artifact。
