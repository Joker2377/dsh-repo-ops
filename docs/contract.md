# 凍結契約：dsh-repo-ops 的模組介面

這份文件是實作的唯一依據。函式簽名、回傳欄位、錯誤字串風格以這裡為準；
要改契約先改這份文件，不要在實作裡單方面加欄位或改欄位名。

## 共用的底層

lib/cli.js 匯出 createRunner(options)，得到 { run, locate, reset }：

- run(name, args, opts) → Promise<RunResult>，RunResult = { ok, code, stdout, stderr, command, file?, timedOut?, retried?, error? }
- 失敗不擲 exception，一律回 ok:false 加 error（一句話，含下一步）
- name 是 'git' 或 'gh'；opts = { cwd, timeoutMs, stdin, env, retries }
- lib/index.js 建立一份 runner，注入 git 與 github 兩邊；模組自己不建 runner

lib/format.js 匯出 fields / table / section / bullets / checkMark / checkSummary / plural / parseAheadBehind / diffStat / nextStep / report / clip / MARK。
checkMark(status, conclusion) 回的是標記字串；要 bucket 值（pass|fail|pending|skipped|neutral|unknown）請用 lib/bucket.js 的 bucketOf(status, conclusion)，它與 checkMark 同一張表。

## 通則（lib/git.js 與 lib/github.js 都遵守）

1. 每個函式回 { ok: true, ...data } 或 { ok: false, error: '一句話，含下一步' }。
2. 只讀函式的 error 不得出現「已建立／已推送」這類完成語氣。
3. 寫入型函式在 ok:true 的資料裡帶 command（實際跑的那行 argv，字串），讓模型看得到跑了什麼。
4. 預設值一律不動遠端：不 force push、不 --no-verify、不 --delete、不 auto-merge。
5. 破壞性動作（force push、刪分支、merge、刪 release、reset、workflow dispatch）在 confirm 不為 true 時不執行，回 { ok:false, needsConfirm:true, error, command }，command 是它本來要跑的那行。
6. 路徑參數叫 path：repo 根目錄或其子目錄的絕對路徑；未给時用呼叫端傳進來的 cwd（工具層負責給，見下），模組層自己不讀 process.cwd()。
7. 解析 git/gh 的 JSON 一律經 cli.js 的 parseJson，失敗時把 gh 版本一行附在 error 後面。

## lib/git.js

export function createGit({ run, env }) — 內部一律 run('git', args, { cwd })。

| 函式 | 成功時的 data |
| --- | --- |
| resolveRepo(path, cwd) | { root, insideWorkTree, gitDir, bare } |
| status({ path, cwd }) | { root, branch, detached, head: { sha, short, subject, author, date }, upstream: { name, remote, branch } 或 null, ahead, behind, defaultBranch, remoteUrl, files: [{ xy, status, path, original? }], stagedCount, unstagedCount, untrackedCount, clean, hint? } |
| log({ path, cwd, limit = 20, ref, author, paths }) | { commits: [{ sha, short, author, email, date, subject }] } |
| diff({ path, cwd, staged, ref, base, paths, statOnly = true, maxChars }) | { stat, patch, files: [string], range } |
| stage({ path, cwd, paths, all = false }) | { added: [string], skippedUntracked: [string], command } |
| commit({ path, cwd, paths, message, amend = false, allowEmpty = false }) | { sha, short, summary, emptyRejected, command } |
| push({ path, cwd, branch, setUpstream = false, forceWithLease = false, force = false, dryRun = false, remote = 'origin', confirm }) | { output, before, after, dryRun, command, remoteUrl } |
| fetch({ path, cwd, prune = true, remote = 'origin' }) | { output, command } |
| pull({ path, cwd, rebase = false }) | { output, conflicts: [string], command } |
| sync({ path, cwd, base, action = 'fetch', confirm }) | { action, base, behind, ahead, output, command }（action=merge 需 confirm） |
| branches({ path, cwd, all = true }) | { current, local: [{ name, head, tracking, ahead, behind, subject }], remote: [{ name, subject }] } |
| createBranch({ path, cwd, name, base, checkout = false }) | { name, created, checkedOut, command } |
| switchBranch({ path, cwd, name, create = false, base, discard = false, confirm }) | { current, discarded: [string], command } |
| deleteBranch({ path, cwd, names, force = false, remote, confirm }) | { deleted: [string], refused: [{ name, reason }], command } |
| tag({ path, cwd, action = 'list', name, message, pushTo, confirm }) | { tags: [{ name, subject }], created?, pushed?, command }；pushTo 有值時多回 { pushed: { remote, ok, command, output\|error, hint? } } |
| stash({ path, cwd, action = 'list', message }) | { entries: [string], restored?, dropped?, command } |
| worktrees({ path, cwd }) | { worktrees: [{ path, branch, head, detached, prunable }] } |
| undo({ path, cwd, kind = 'commit', confirm }) | { undone, command }；kind='commit' 是 reset --soft HEAD~1，需要 confirm |
| mergeBase({ path, cwd, base }) | { base, mergeBase, behind, ahead } |

git 側規則：

- 每個 git 呼叫都加 -c core.quotepath=false、--no-pager（有子命令支援時）、--no-replace-objects（狀態類唯讀命令）。
- status 用 git status --porcelain=v2 --branch；v2 不可用時退回 v1，兩條解析路徑都要有測試。
- ahead/behind 用 git rev-list --left-right --count <upstream>...HEAD；沒有 upstream 時兩者為 null，並在 hint 建議 setUpstream。
- defaultBranch 由 refs/remotes/origin/HEAD 取；取不到回 null，不要猜 main。
- commit message 用 -m 傳（不寫檔、不進 shell）；多個 -m 各成一段。
- 不提供 --no-verify。
- 所有 path 解析失敗的 error 都要給下一步（「請傳 path 指向 repo 內任一目錄」）。

## lib/github.js

export function createGithub({ run, cwd }) — 內部一律 run('gh', args, { cwd })。

| 函式 | 成功時的 data |
| --- | --- |
| authStatus({}) | { loggedIn, user, hostname, scopes: [string], gitProtocol }（不含 token 原文） |
| repoInfo({ path, repo, cwd }) | { owner, repo, defaultBranch, url, host, source: 'gh' 或 'remote' } |
| prStatus({ path, repo, branch, cwd }) | { branch, pr: { number, title, state, isDraft, url, baseRefName, headRefName, reviewDecision, mergeable, mergeStateStatus, checks: [{ name, bucket, state, conclusion, url }] } 或 null } |
| prList({ path, repo, state = 'open', author, limit = 20, base, cwd }) | { pulls: [{ number, title, state, isDraft, headRefName, updatedAt, url, reviewDecision }] } |
| prView({ path, repo, number, files = false, commits = false, comments = 5, cwd }) | { pr: { 同 prStatus.pr，外加 body, files[], commits[] }, comments: [{ author, createdAt, body }] } |
| prCreate({ path, repo, title, body, base, head, draft = false, fill = false, deleteBranch = false, reviewer, assignee, cwd }) | { number, url, base, head, command } |
| prUpdate({ path, repo, number, title, body, base, addReviewer, addAssignee, ready, cwd }) | { url, changed: [string], command } |
| prComment({ path, repo, number, body, cwd }) | { url, command } |
| prReviewComments({ path, repo, number, cwd }) | { comments: [{ id, path, line, author, body, inReplyToId, resolved }] } |
| prReply({ path, repo, number, commentId, body, resolve = false, cwd }) | { url, command } |
| prDiff({ path, repo, number, statOnly = true, maxChars, cwd }) | { stat, patch, files: [string] } |
| prCheckout({ path, repo, number, branch, cwd }) | { branch, command } |
| prReady({ path, repo, number, cwd }) | { url, command } |
| prMerge({ path, repo, number, strategy = 'squash', deleteBranch = false, auto = false, confirm, cwd }) | { merged, auto, url, command }（未 confirm 走通則第 5 條） |
| prChecks({ path, repo, branch, number, cwd }) | { checks: [{ name, bucket, state, conclusion, url, job }] } |
| ciList({ path, repo, branch, workflow, status, limit = 20, cwd }) | { runs: [{ id, name, displayTitle, branch, event, status, conclusion, bucket, createdAt, url, headSha }] } |
| ciView({ path, repo, runId, failedOnly = false, cwd }) | { run: { id, name, status, conclusion, url, jobs: [{ id, name, status, conclusion, bucket, steps: [{ name, status, conclusion }] }] } } |
| ciLogs({ path, repo, runId, job, attempt, tailLines = 200, failedOnly = true, cwd }) | { text, truncated, lines } |
| ciWatch({ path, repo, runId, timeoutMs = 300000, intervalMs = 10000, cwd }) | { status, conclusion, url, waitedMs, timedOut }（輪詢，不用 --watch） |
| ciRerun({ path, repo, runId, failedOnly = true, confirm, cwd }) | { rerun: true, command } |
| ciStatus({ path, repo, branch, cwd }) | { runs: [最近 5 條，同 ciList 的列], failing: [{ runId, job, name, url }] } |
| issueList({ path, repo, state = 'open', limit = 20, assignee, label, cwd }) | { issues: [{ number, title, state, updatedAt, url, author }] } |
| issueView({ path, repo, number, comments = 5, cwd }) | { issue: { number, title, state, body, url, labels, assignees, author, createdAt }, comments: [{ author, createdAt, body }] } |
| issueCreate({ path, repo, title, body, assignee, label, draft = false, cwd }) | { number, url, command } |
| issueComment({ path, repo, number, body, cwd }) | { url, command } |
| issueSetState({ path, repo, number, state = 'closed', reason, lock, cwd }) | { url, state, command } |
| releaseList({ path, repo, limit = 10, cwd }) | { releases: [{ tag, name, isLatest, isDraft, isPrerelease, publishedAt }], assetsKnown: false }（gh release list 沒有 assets 欄位） |
| releaseView({ path, repo, tag, cwd }) | { release: { tag, name, body, isDraft, isPrerelease, isLatest: null, publishedAt, assets: [{ name, size, url }], url }, assetsKnown: true }（gh 2.92 的 release view 沒有 isLatest 欄位） |
| releaseCreate({ path, repo, tag, name, body, assets = [], draft = false, prerelease = false, latest = true, target, generateNotes = false, cwd }) | { url, tag, command } |
| releaseEdit({ path, repo, tag, name, body, draft, prerelease, latest, cwd }) | { url, command } |
| releaseDelete({ path, repo, tag, deleteTag = false, confirm, cwd }) | { deleted, command } |
| workflowList({ path, repo, cwd }) | { workflows: [{ id, name, state, path }] } |
| workflowRun({ path, repo, workflow, ref, confirm, cwd }) | { dispatched, command } |

gh 側規則：

- 要結構化資料就用 --json，並把 --json 的欄位名寫成一個可匯出的常數（PR_JSON、RUN_JSON、RELEASE_JSON、ISSUE_JSON），方便測試對照。
- --repo 的優先序：參數 repo > 由 path 的 git remote 推得。推不出來時 error 要寫「請傳 repo（owner/name）」。
- authStatus 的失败提示 gh auth login；這是我唯一允許出現的「請使用者自己跑」的指令，工具本身不跑它。
- ciWatch 輪詢上限就是 timeoutMs，每 intervalMs 查一次，逾時回 timedOut:true 而不是無限等。
- 需要分頁時用 gh api --paginate，並在 limit 處截。
- gh 輸出裡的 URL 一律原樣保留，不裁剪。

## lib/tools.js

- createTools({ git, github, config, resolveCwd }) → defineTool 包過的工具陣列（九個）。
- lib/index.js 只負責：讀 config → 建 runner → 建 git/github → 在 ctx.effect 內註冊。
- 工具名固定九個：repo_status、repo_diff、repo_commit、repo_push、repo_branch、repo_pr、repo_ci、repo_issue、repo_release。
- 參數方言：扁平 map，每欄 { type, description, required?, enum? }；預設值寫在 description 文字裡（host 不吃 schema 的 default 關鍵字）。
- 每個工具 output.schema = { type: 'string' }，render 回 [{ type: 'text', text: value }]。
- 唯讀工具 isConcurrencySafe: () => true；寫入型 () => false。
- 每個工具 timeoutMs 給 120000；repo_ci 的 watch 用 330000（輪詢上限加餘裕）。
- 工具的 cwd 由 execute 的第二參數取：exec?.agent?.session?.header?.cwd ?? process.cwd()。
