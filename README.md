# HerdrCommander

讓 Claude Code 與 Codex 在 [herdr](https://herdr.dev)（terminal multiplexer for coding agents）裡協作的工具組：

- **claude-mod/**：Claude Code mod（function-hook plugin，Claude Code 2.1.287）。在 herdr 裡提供 `/commander` 面板、herdr 狀態回報、跨 agent job；**不在 herdr 裡時完全不生效**。
- **bridge/**：herdr-bridge，Claude 與 Codex 共用的一層（Node 22、純 JS、零相依）。所有 herdr 操作、job 紀錄、安全規則都在這裡。提供 CLI、STDIO MCP server、Codex 用的 dashboard。
- **codex/**：Codex 啟動器 `herdr-codex.ps1` 與 commander／worker 手則。

計畫與逐 API 決策：`~/.claude/plans/gentle-exploring-parrot.md`（Codex 端原始提案：`~/.claude/plans/codex-herdr-commander.md`）。

## 隔離原則

整套只放在這個資料夾，**不寫任何全域位置**：不改 `~/.claude/settings.json`、`~/.claude/skills`、`~/.codex/*`、PATH、全域 npm。執行期資料寫在 `.runtime/`（已 gitignore）。

- Claude：只在你啟動時加 `--plugin-dir` 的那個 session 生效。
- Codex：只在用 `herdr-codex.ps1` 或 bridge 開出來的那個 Codex 生效，全部用 `codex -c` 覆寫帶入；普通 `codex` 不受影響。

## 使用

### Claude 當 commander

在 herdr 的 pane 裡：

```powershell
claude --plugin-dir 'D:\tool\HerdrCommander\claude-mod'
```

然後輸入 `/commander`。會取得這個 workspace 的 commander lease、打開 Commander 面板，並擋掉自己的 Write／Edit／NotebookEdit。`/commander off` 結束。

面板內容：各 agent 的狀態燈號、kind、持續時間、title（依 workspace 分組，blocked 排最前）、選中 agent 的最近輸出、自己派出去的 jobs。

面板按鍵（面板取得焦點時）：`f` 聚焦、`x` 中斷（再按 `y` 送 Esc／`c` 送 Ctrl+C／`n` 取消）、`r` 重新整理；下方輸入框可直接送 prompt 給選中的 agent。

模型可用的工具：`herdr_agents_list`、`herdr_agent_read`、`herdr_job_get`、`herdr_message_send`、`herdr_worker_spawn`、`herdr_job_interrupt`（一律先問你）。

### Codex 當 commander 或 worker

```powershell
& 'D:\tool\HerdrCommander\codex\herdr-codex.ps1' -Role commander -WithDashboard
& 'D:\tool\HerdrCommander\codex\herdr-codex.ps1' -Role worker
```

commander 會以 `-s read-only` 啟動，`-WithDashboard` 會在下方開一個 dashboard pane（`↑↓` 選、`f` 聚焦、`x` 中斷並確認、`r`、`q`）。

### 一個 workspace 一個 commander

Claude 與 Codex 共用同一份 lease（`.runtime/<workspace>/lease.json`）。另一個 pane 還活著時，第二個 commander 會被拒；持有者的 pane 消失就自動讓出。

## 功能開關（userConfig）

| 開關 | 預設 | 內容 |
|---|---|---|
| `lifecycleReport` | 開 | 把這個 pane 的 working／blocked／idle 回報給 herdr（`pane report-agent`），結束時釋放 |
| `notifications` | 開 | commander 模式下，別的 agent 變 blocked 或完成時發 herdr 通知與 toast |
| `listAgentsAugment` | 開 | ListAgents 的結果附上 herdr agents（用 `context`，不改原結果） |
| `sendMessageRoute` | 開 | SendMessage 給 herdr pane id／agent 名稱時，改成 herdr job |
| `pushNotificationMirror` | 開 | PushNotification 照原生送，另外再發一則 herdr 通知 |
| `backgroundTools` | **關**（P2） | 新增 `herdr_bg_run`／`herdr_bg_read`／`herdr_bg_stop`，並在 Bash／PowerShell 描述加提示 |
| `agentPanes` | **關**（P3） | 新增 `herdr_agent_spawn`，並在 Agent 描述加提示 |
| `deliverFlow` | **關**（P4） | herdr 內展開 `/deliver` skill 時附上 herdr pane 版流程 |
| `pollSeconds` | 3 | 輪詢間隔（一次 herdr 呼叫約 1.2 秒） |

`--plugin-dir` 載入的 plugin 從 `settings.json` 的 `pluginConfigs["herdr-commander"].options` 讀值。依隔離原則我沒有寫入；要開 P2 之後的功能，由你決定要不要加。

## 安全規則（都在 bridge）

**這是護欄，不是沙箱。** 下列規則只約束經過 bridge／MCP 的呼叫。模型如果用 Bash 直接執行 `herdr ...`，或自己呼叫 `cli.mjs` 並加上 `--by-user`（這個旗標沒有驗證身分），都能繞過。commander 擋 Write／Edit 也一樣，shell 仍然可以寫檔。

- 禁止透過 bridge 執行：`server stop`、`server live-handoff`、`session stop/delete`、`workspace close`、`tab close`、`worktree remove`、`integration install/uninstall`、`plugin install/uninstall`。
- `pane close` 只限 bridge 自己開的 pane（`.runtime/<ws>/owned.json`）。
- worker 一律不能再開 worker（防遞迴）：bridge 開的 pane 都帶 `HERDR_COMMANDER_ROLE=worker`。
- 經過 bridge 的模型呼叫只能中斷自己派工或自己開的 pane；面板按鈕（你按的，帶 `--by-user`）可以中斷任何非自己的 pane。Claude 端呼叫 `herdr_job_interrupt` 一律跳權限詢問（D1）。
- job 完成只認兩種證據：受派者本人呼叫 `herdr_job_complete`（帶 `result` 全文，由 bridge 寫成結果檔），或結果檔帶檔頭 `job_id: <id>`。agent 的 idle／done／unknown 一律不算完成；送達失敗記為 `delivery_unknown`，不自動重送。
- 完成時通知派工者一次（job 的 `woken`）：Claude 派工者由 mod 自己輪詢喚醒；Codex 派工者在 idle 時收到一行 prompt，忙碌時由它的 MCP server 每 10 秒重試。
- worker 開起來就卡在 prompt（資料夾信任、登入）時，不送任務，回報 `blocked`，由你到那個 pane 處理。
- MCP 只走 STDIO，沒有網路 listener。

## 測試

```powershell
cd D:\tool\HerdrCommander\bridge; node --test test/bridge.test.mjs   # 25 項，假 herdr，不碰實機
cd ..\claude-mod; claude plugin validate .; claude plugin test .                  # 17 項
```

型別檢查：mod 被載入一次後，引擎會在 `claude-mod/.claude-plugin/types/` 放 `tsconfig.json`。本機沒有 TypeScript 5.4+ 的 `tsc`，我是用 VS Code 內附的 TypeScript 5.6（`typescript.js` API）跑同一份 tsconfig，結果 0 錯誤。

## P0 spike 結果

| # | 項目 | 結果 |
|---|---|---|
| ① | mod 能否讀 `HERDR_ENV` 等環境變數 | 可以（`$.env.get`） |
| ② | `herdr`、`node` 裸名能否在 `$.process.run` 叫到 | 可以 |
| ③ | herdr 呼叫延遲 | 每次約 1.2 秒，輪詢預設 3 秒 |
| ④ | Pane 在 herdr 終端裡的繪製 | 正常；寬度 < 60 時隱藏 kind／狀態／時間 |
| ⑤ | `report-agent`／`release-agent` | 可行，但 **pane id 必須緊接在子命令後面**，help 上的順序是錯的 |
| ⑥ | blocked 偵測 | `tool.check` 回 `ask` 不可靠（auto mode／規則會在背後放行，實測會誤報 blocked）；改用 `classic.PermissionRequest`（權限對話框真的出現才觸發） |
| ⑦ | 能否偽造 Bash／Agent／Monitor 的結果（A 路） | **不行**：這版沒有 TaskOutput，背景任務由引擎內部追蹤。改走 **B 路**：新增專用工具，原生工具不動 |
| ⑧ | node 與 bridge 啟動 | node 22.22，單次 bridge 呼叫約 1.3 秒（大部分是 herdr） |
| ⑨ | `codex -c developer_instructions`／`mcp_servers` 覆寫 | 生效：Codex worker 會呼叫 `herdr_bridge.herdr_job_complete`。副作用：Codex 提示「-c 需 embedded mode，不使用共用背景 server」，這反而更隔離 |
| ⑩ | Codex 在 pane 首次進 repo 是否卡 trust | 沒有（D:\tmd\Inanna 已信任） |
| ⑪ | `herdr plugin pane open` 能否當 dashboard | 子命令存在（只是沒列在 `herdr --help`），未採用；dashboard 用一般 pane 跑 TUI |

## 實機驗證紀錄（2026-10-02）

都在測試用 pane 跑，測完已關閉。

- herdr 外（清掉 `HERDR_*`）：模型回報沒有任何 herdr 工具，系統提示也沒有 herdr-commander。
- headless：`herdr_agents_list` 經 bridge 列出實際的 agents。
- 互動式 Claude commander：`/commander` 取得 lease、面板正常顯示；`herdr_worker_spawn` 在 19 秒內開好 Codex worker；worker 讀任務檔、寫結果檔、透過 MCP 呼叫 `herdr_job_complete`；commander 被喚醒（`$.prompt.submit`）並讀結果檔驗收。共兩個 job，兩次都完成。
- `/commander off`：lease 釋放、面板關閉。
- Codex commander＋dashboard：dashboard 正常顯示 jobs；Claude 持有 lease 時 Codex 的 claim 被拒。
- 背景指令（bridge 直接呼叫）：在新 pane 執行、exit code 3 正確抓到、`close` 關閉 pane。
- lifecycle（headless）：執行期間 pane 顯示 working，結束後釋放回 herdr 自行偵測。
- herdr 通知：`notify` 正常。
- Codex commander 派工：Codex commander 在 `D:\TMD\StormOfSeth2` 開 Claude worker（回報分支 `Release`）與 Codex worker（回報 `4d430b8`），兩個答案都與 repo 實際一致；兩次 commander 都被喚醒（`woken: prompt`）並自己讀 job。worker 都是用 `result` 文字交回，沒有寫 `.runtime` 的權限問題。
- Claude worker：上面那次就是 Claude worker，在另一個 repo 跑、由 Codex commander 派工。
- 隔離：整個測試期間 `~/.codex/config.toml` 修改時間停在 17:55（第一次啟動 Codex 是 19:10）。

### 實機抓到並已修正的問題

1. 多行 job prompt 送進 Codex 時換行被吃掉、Enter 也沒送出 → 完整任務改寫進任務檔（`.runtime/<ws>/tasks/<job>.md`），只送一行 prompt；目標是 Codex 時，4 秒內沒進入 working 就補一次 Enter（記錄在 job 的 `nudged`）。
2. 背景指令的 `exit` 會關掉 pane 的 shell，且 PowerShell 5.1 會把 `$LASTEXITCODE:` 解析成磁碟機變數 → 改用子行程 `powershell -NoProfile -EncodedCommand`，exit 標記改成 `${LASTEXITCODE}`。
3. herdr pane id 可能是字母（`wA:pA`）→ 正則放寬。
4. `report-agent` 等指令參數順序錯誤，回報其實沒生效 → 修正並加測試鎖住順序。
5. `tool.check` 的 `ask` 造成 blocked 誤報 → 改用 `classic.PermissionRequest`。
6. Codex commander 的 dashboard 分割比例給反，Codex 只剩 2 行 → `--ratio 0.7`。
7. 結果檔先被輪詢對到（`completed_via: result_file`）時，之後的 `herdr_job_complete` 直接回 `already`，Codex commander 永遠不會被喚醒 → 改成「轉為 completed 的當下」觸發一次通知，並用 `woken` 旗標記錄，忙碌時重試；喚醒與面板送 prompt 都改走會補 Enter 的同一條路。
8. worker 在別的 repo 可能沒權限寫 `.runtime` → `herdr_job_complete` 收 `result` 全文，由 bridge 代寫。
9. Codex commander 結束後 shell pane 還在，lease 會卡住 → lease 存活改成「pane 裡還有同 kind 的 agent」，Codex 結束時 `codex-launch` 也會主動釋放；MCP 的 claim 記成 kind `codex`。
10. worker 開起來卡在資料夾信任對話框時，bridge 仍把任務打進去（等於在對話框上打字）→ 開起來是 blocked 就不送任務並回報。
11. （2026-10-05）任務檔是無 BOM 的 UTF-8，Codex worker 用 PowerShell 5.1 的 `Get-Content` 讀會以 Big5 解碼成亂碼（超過一行 prompt 預覽 160 字的中文任務就看不到）→ 任務檔改成帶 BOM 寫入。

## 已知限制與未做項目

- **沒做**：Codex App Server bridge（官方仍標 experimental，未經你同意不引入）、`events.subscribe` 推播（CLI 沒有對應指令，要另寫連 `herdr.sock` 的程式；目前用輪詢）、`herdr_worktree` 工具、ACK／去重的完整訊息協定（P2，目前只靠 job_id＋結果檔）。
- **沒實機測**：
  - 互動式的權限對話框 → blocked：程式改用 `classic.PermissionRequest`，但沒有真的觸發一次。
  - P2～P4 的開關在 mod 端只跑了單元測試，因為要開它們得寫 `settings.json`。bridge 的背景指令有實機測。
  - Codex dashboard 的 `wakePending` 與 Codex 結束時釋放 lease：有單元測試，沒有實機看過。
  - 從 Claude commander 直接開 Claude worker（反方向的 Codex commander → Claude worker 有測）。
- 每次 herdr 呼叫約 1.2 秒；commander 模式下輪詢與預覽會持續有 node 行程。
- `agent read` 讀不到 alternate screen 已捲走的內容，所以結果一律走檔案。
- SendMessage 改走 herdr 時，對方收到的是一個 job（kind=question），要寫結果檔才算回覆。
- `.runtime/<ws>/owned.json` 若 pane 是被手動關閉的，會留下過期項目（不影響功能）。
- D4（Codex 的 herdr integration）仍待你決定；目前 Codex 狀態靠 herdr 讀畫面。

## 給 review 的重點

- `bridge/lib/ops.mjs`：所有 herdr 操作與規則（禁止清單在 `lib/herdr.mjs`）。
- `claude-mod/hooks/register.tsx`：所有用到 `$` 的程式。引擎規定 `$` 不能跨 import 傳遞、state atom 必須宣告在同一檔，所以集中在這裡；純函式在 `hooks/pure.ts`。
- `codex/herdr-codex.ps1` → `bridge/cli.mjs codex-launch`：Codex 的參數交給 node 去 quote，因為 PowerShell 5.1 會弄壞含引號的 native 參數。
