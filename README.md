# HerdrCommander

讓 Claude Code 與 Codex 在 [herdr](https://herdr.dev)（terminal multiplexer for coding agents）裡協作的工具組：

- **repo 根目錄就是 Claude Code plugin**（`.claude-plugin/plugin.json`、`hooks/`、`types/`、`tests/`）：function-hook mod（Claude Code 2.1.287+）。在 herdr 裡提供 `/commander` 面板、herdr 狀態回報、跨 agent job；**不在 herdr 裡時完全不生效**。`.claude-plugin/marketplace.json` 讓這個 repo 同時也是 marketplace。
- **bridge/**：herdr-bridge，Claude 與 Codex 共用的一層（Node 22、純 JS、零相依）。所有 herdr 操作、job 紀錄、安全規則都在這裡。提供 CLI、STDIO MCP server、Codex 用的 dashboard。
- **codex/**：Codex 啟動器 `herdr-codex.ps1` 與 commander／worker 手則。

計畫與逐 API 決策：`~/.claude/plans/gentle-exploring-parrot.md`（Codex 端原始提案：`~/.claude/plans/codex-herdr-commander.md`）。

## 安裝（從 GitHub）

repo 是 private，git 要能用你的帳號存取（走 HTTPS 的話，先跑過 `gh auth login` 與 `gh auth setup-git`）。

```powershell
claude plugin marketplace add jijia-Huang/HerdrCommander
claude plugin install herdr-commander@herdr-commander
```

裝好後所有 Claude session 都會載入它，但**不在 herdr 裡時完全不生效**（每個 hook 都先檢查 `HERDR_ENV`／`HERDR_PANE_ID`）。

更新：版本號在 `.claude-plugin/plugin.json`（目前 `0.2.1`）。**只有改了版本號，`claude plugin update` 才會更新**；更新後在 session 內跑 `/reload-plugins`。

```powershell
claude plugin update herdr-commander@herdr-commander
```

安裝版是 Claude Code 複製到 `~/.claude/plugins/cache/herdr-commander/herdr-commander/<版本>/` 的那一份（整個 repo，含 `bridge/`、`codex/`）。

### 開發時

改 working copy 不用重裝：`claude --plugin-dir 'D:\tool\HerdrCommander'` 會用這一份，並蓋過同名的安裝版。從這一份開出來的 Claude worker 也會帶同樣的 `--plugin-dir`；安裝版開的 worker 則用一般的 `claude`。

注意：在 `D:\Tool\HerdrCommander` 裡啟動 `claude`（帶不帶 `--plugin-dir` 都一樣），Claude Code 會跳資料夾信任對話框。10-05 `git init` 之後，上層 `D:/Tool` 的信任就不再涵蓋這個資料夾，而 `D:/Tool/HerdrCommander` 本身沒被信任過。要在這裡開，就自己按一次信任；不然就換個 cwd 啟動（10-05 的實測是從 `D:\Tool` 啟動的）。

## 執行期資料與隔離

執行期資料（jobs、results、tasks、workers、out、panes、lease、owned）放在 `%LOCALAPPDATA%\herdr-commander\runtime\<workspace>\`，不在 plugin 資料夾裡。所以更新不會清掉它，安裝版、開發版、Codex 啟動器也共用同一份。`HERDR_BRIDGE_RUNTIME` 可以改這個位置（測試用）。

- Claude：plugin 裝在使用者層級，但 herdr 外什麼都不做。
- Codex：只有用 `herdr-codex.ps1` 或 bridge 開出來的那個 Codex 會生效，全部用 `codex -c` 覆寫帶入；一般的 `codex` 不受影響，也不寫 `~/.codex/*`。

## 使用

### Claude 當 commander

在 herdr 的 pane 裡啟動 `claude`（裝好 plugin 後直接啟動；開發時用 `claude --plugin-dir 'D:\tool\HerdrCommander'`），然後輸入 `/commander`。會取得這個 workspace 的 commander lease、打開 Commander 面板，並擋掉自己的 Write／Edit／NotebookEdit。`/commander off` 結束。

面板內容：各 agent 的狀態燈號、kind、持續時間、title（依 workspace 分組，blocked 排最前）、選中 agent 的最近輸出、自己派出去的 jobs。

面板按鍵（面板取得焦點時）：`f` 聚焦、`x` 中斷（再按 `y` 送 Esc／`c` 送 Ctrl+C／`n` 取消）、`r` 重新整理；下方輸入框可直接送 prompt 給選中的 agent。

### 在 herdr 裡，Claude 的原生工具走 herdr（0.2.0 起，總開關 `takeover`，預設開；本節是 0.2.1 的行為）

模型照常用 Claude 原生工具，由 mod 在背後接管；自訂的 herdr 工具只剩一個 `herdr_worker_spawn`。

| 原生工具 | 在 herdr 裡變成 |
|---|---|
| Agent，`subagent_type` 是 `herdr-commander:claude-worker` 或 `herdr-commander:codex-worker` | 在 commander 所在的資料夾旁開一個 herdr pane，裡面跑 Claude 或 Codex worker。立刻回「已在背景啟動」，id 是 `herdr-agent-<workspace>-<6 碼>`，outputFile 是 bridge 維護的 Markdown 紀錄（任務、雙方訊息、每次 Read 時的最新畫面）。**其他類型（Explore、general-purpose 等）、fork、remote 一律照原生，不開 pane（使用者已定）** |
| SendMessage | worker 傳給 `main`（或派工者的 pane id／名字）：原樣轉給派工者。派工者傳給 worker（herdr id、名字、pane id）：併進進行中的 job；上一個 job 已完成就重新打開同一個 job；worker 正忙別人的 job 就排隊。不看訊息內容 |
| TaskStop（herdr id，或自己開的 worker 的名字／pane id） | 送 Ctrl+C、關掉 pane，**不問人**；別人開的 pane 一律拒絕 |
| ListAgents | 原生清單後面接著列：自己開的 herdr worker（id、名字、狀態、目前的 job、排隊數、資料夾、輸出檔），以及其他 herdr pane 的畫面檔路徑 |
| Read 執行期資料夾裡的檔案 | 先由 bridge 刷新（worker 輸出檔補上最新畫面；`panes\<pane>.txt` 寫入該 pane 畫面），再交給原生 Read；這個資料夾的 Read 不跳權限詢問 |
| 背景 Bash／PowerShell（`run_in_background`）、Monitor | **不接管，一律是 Claude 原生**（在 herdr 裡也一樣，使用者已定） |
| `herdr_worker_spawn`（唯一保留的工具，commander／plain） | 在**別的**資料夾開 worker（`cwd`、`kind`、`task` 必填，`name` 選填）；給這個 session 自己的資料夾會被拒，請改用 Agent |

Claude worker 怎麼收到工作：派工者的任務和之後用 SendMessage 送來的訊息，**直接以內容本身**送進 worker（跟原生收到訊息一樣，多行也完整保留），不加任何開頭、也不叫它去讀檔。只有內容送不了時才改成「寫進任務檔＋一行提示」：超過 30,000 字（herdr 用命令列參數送字，Windows 整條命令列上限 32,767 個 UTF-16 字元；實測 31,081 字完整送達、33,000 字 herdr 起不來）、含終端機會當成控制碼的字元、或第一個字是 `/`、`!`、`#`（Claude Code 會當成指令、shell 或記憶）。Codex worker 和不是 bridge 開的 Claude pane 照舊收一行 `[herdr-job …]` 提示加任務檔。送出後幾秒內 pane 沒進入 working，就補一次 Enter（剛啟動的 Claude／Codex 偶爾會留下文字、吃掉 Enter）。

worker 怎麼知道要用 SendMessage 回報：mod 把說明附在每則送進 worker 的訊息上，當作模型看得到、使用者看不到的 context（commander 的規則則在每個角色的第一則訊息附上一次）。原因是實測時內建的安全 plugin 會略過使用者層 plugin 的 `prompt.compose`（debug log：`herdr-commander: prompt.compose bypassed by cc-plugin-sec-default`），只靠系統提示的話模型根本看不到。

job 怎麼算完成：worker 已經傳過訊息給派工者，**而且** worker 停下來了（worker 自己的 mod 在一輪結束時告訴 bridge）。停下來卻沒傳訊息，只提醒派工者一次，不自動完成。派工者被通知的時機：worker 傳來訊息、job 完成、停了沒傳訊息、worker 開不起來或卡在信任對話框。通知用 plugin prompt 送進來，要等 session 閒下來。

一個 worker 一次只做一個 job，其他 job 排隊；想平行就多開幾個 worker。

Codex 端不變：Codex commander／worker 照舊用 `bridge/mcp.mjs` 的 MCP 工具（`herdr_job_complete`、結果檔帶 `job_id:` 檔頭）。排隊、重新打開 job 由 bridge 處理，Codex 一樣適用。

### Codex 當 commander 或 worker

```powershell
& 'D:\tool\HerdrCommander\codex\herdr-codex.ps1' -Role commander -WithDashboard
& 'D:\tool\HerdrCommander\codex\herdr-codex.ps1' -Role worker
```

commander 會以 `-s read-only` 啟動，`-WithDashboard` 會在下方開一個 dashboard pane（`↑↓` 選、`f` 聚焦、`x` 中斷並確認、`r`、`q`）。

### 一個 workspace 一個 commander

Claude 與 Codex 共用同一份 lease（`<runtime>/<workspace>/lease.json`）。另一個 pane 還活著時，第二個 commander 會被拒；持有者的 pane 消失就自動讓出。

## 功能開關（userConfig）

| 開關 | 預設 | 內容 |
|---|---|---|
| `takeover` | 開 | 在 herdr 裡接管 Claude 原生工具（上一節整張表）並加上 `herdr_worker_spawn`。關掉時這些工具全部是原生行為 |
| `lifecycleReport` | 開 | 把這個 pane 的 working／blocked／idle 回報給 herdr（`pane report-agent`），結束時釋放 |
| `notifications` | 開 | commander 模式下，別的 agent 變 blocked 或完成時發 herdr 通知與 toast |
| `pushNotificationMirror` | 開 | PushNotification 照原生送，另外再發一則 herdr 通知 |
| `deliverFlow` | **關** | herdr 內展開 `/deliver` skill 時附上 herdr pane 版流程 |
| `pollSeconds` | 3 | 輪詢間隔（一次 herdr 呼叫約 1.2 秒） |

開關的值從 `settings.json` 的 `pluginConfigs` 讀取（安裝版也可以在 `/plugin` 的設定選單裡改）。0.1.0 的 `listAgentsAugment`、`sendMessageRoute`、`backgroundTools`、`agentPanes` 已併入 `takeover`，留在設定裡也會被忽略。

## 安全規則（都在 bridge）

**這是護欄，不是沙箱。** 下列規則只約束經過 bridge／MCP 的呼叫。模型如果用 Bash 直接執行 `herdr ...`，或自己呼叫 `cli.mjs` 並加上 `--by-user`（這個旗標沒有驗證身分），都能繞過。commander 擋 Write／Edit 也一樣，shell 仍然可以寫檔。

- 禁止透過 bridge 執行：`server stop`、`server live-handoff`、`session stop/delete`、`workspace close`、`tab close`、`worktree remove`、`integration install/uninstall`、`plugin install/uninstall`。
- `pane close` 只限 bridge 自己開的 pane（`<runtime>/<ws>/owned.json`）。
- worker 一律不能再開 worker（防遞迴）：bridge 開的 pane 都帶 `HERDR_COMMANDER_ROLE=worker`。
- TaskStop 只能結束自己開的 worker（送 Ctrl+C 並關 pane，不問人，跟原生 TaskStop 一樣）；別人開的 pane 一律拒絕。面板按鈕（你按的，帶 `--by-user`）可以對任何非自己的 pane 送 Esc／Ctrl+C。
- job 完成的證據（都是 bridge 的紀錄，不看文字格式）：Claude worker 傳過訊息給派工者、之後它自己的 mod 回報這一輪結束；Codex worker 呼叫 `herdr_job_complete`（帶 `result` 全文，由 bridge 寫成結果檔），或結果檔帶檔頭 `job_id: <id>`。agent 的 idle／done／unknown 一律不算完成；送達失敗記為 `delivery_unknown`，不自動重送。
- 完成時通知派工者一次（job 的 `woken`）：Claude 派工者由 mod 自己輪詢喚醒；Codex 派工者在 idle 時收到一行 prompt，忙碌時由它的 MCP server 每 10 秒重試。
- worker 開起來就卡在 prompt（資料夾信任、登入）時，不送任務，回報 `blocked`，由你到那個 pane 處理。
- MCP 只走 STDIO，沒有網路 listener。

## 測試

```powershell
cd D:\tool\HerdrCommander\bridge; node --test test/bridge.test.mjs   # 45 項，假 herdr，不碰實機
cd ..; claude plugin validate .; claude plugin test .                            # 29 項；validate 也會檢查 marketplace.json
```

在 herdr 的 worker pane 裡跑測試時，要先清掉 `HERDR_*` 環境變數（Git Bash：`env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_COMMANDER_ROLE ...`），否則 bridge 會把測試本身當成 worker，開 worker 的測試會失敗。

型別檢查：mod 被載入一次後，引擎會在 `.claude-plugin/types/` 放 `tsconfig.json`。本機沒有 TypeScript 5.4+ 的 `tsc`，我是用 VS Code 內附的 TypeScript 5.6（`typescript.js` API）跑同一份 tsconfig，結果 0 錯誤。

## P0 spike 結果

| # | 項目 | 結果 |
|---|---|---|
| ① | mod 能否讀 `HERDR_ENV` 等環境變數 | 可以（`$.env.get`） |
| ② | `herdr`、`node` 裸名能否在 `$.process.run` 叫到 | 可以 |
| ③ | herdr 呼叫延遲 | 每次約 1.2 秒，輪詢預設 3 秒 |
| ④ | Pane 在 herdr 終端裡的繪製 | 正常；寬度 < 60 時隱藏 kind／狀態／時間 |
| ⑤ | `report-agent`／`release-agent` | 可行，但 **pane id 必須緊接在子命令後面**，help 上的順序是錯的 |
| ⑥ | blocked 偵測 | `tool.check` 回 `ask` 不可靠（auto mode／規則會在背後放行，實測會誤報 blocked）；改用 `classic.PermissionRequest`（權限對話框真的出現才觸發） |
| ⑦ | 能否偽造 Bash／Agent／Monitor 的結果（A 路） | 當時判斷「不行」，**10-05 實測推翻**：`tool.call` hook 自己回 `{ result }`，核心會用工具的 output schema 驗證、交給工具自己的 mapper（Agent、Bash、TaskStop、SendMessage、ListAgents 都實測接受），hook 也在引擎驗 id 之前執行。0.2.0 改為接管原生工具 |
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
12. （2026-10-05，Codex review）跨 workspace 派工時，job 存在派工者的 workspace，但 `herdr_job_complete` 只查回報者自己的 workspace → 回 `no_job`，commander 一直看到 `sent` → 改成用 job ID 跨 workspace 找 job（assignee 檢查不變），`listAgents` 的「目前 job」也跨 workspace 找。

## 實機驗證紀錄（2026-10-05，原生工具接管，0.2.0／0.2.1）

在臨時的 herdr workspace（測完已整個關掉）用 `claude --plugin-dir 'D:\Tool\HerdrCommander'` 跑，先 auto mode、後 default mode。

- Agent（`herdr-commander:claude-worker`）：立刻回 `async_launched`，id `herdr-agent-w11-0105cd`；約 25 秒內在右邊開好 Claude worker。
- worker 用 SendMessage 傳給 `main` 兩則（回報＋自己更正），commander 逐則收到原文，worker 停下後收到「完成」通知。
- 派工者再 SendMessage 給這個 worker：結果「reopened your earlier job …, delivered」，同一個 job id，worker 回覆後再次完成。
- 排隊：worker 正在做 commander 的 job 時，另一個派工者送來的 job 進 `queued`；第一個完成後才送出，worker 傳 `main` 時送到第二個派工者，停下後完成。中途 worker 等自己的背景命令而停下（還沒傳訊息），只發了一次「停了沒傳訊息」提醒，沒有誤判完成。
- TaskStop：herdr id → 送 Ctrl+C、關 pane，沒有權限詢問；別人開的 pane（`w11:p3`）→ `not_owned`。
- ListAgents：原生清單後接 herdr worker 與其他 pane 的畫面檔；Read worker 輸出檔與 pane 畫面檔，default 模式下沒有跳權限。
- `herdr_worker_spawn`：給 commander 自己的資料夾 → `same_folder` 拒絕；給 `D:\tmd\Inanna`、kind codex → 開好 Codex worker，它用 `herdr_job_complete` 交件，commander 收到完成通知。
- 0.2.0 曾把背景 Bash 與 Monitor 也接管進 pane（實測可跑），但 auto mode 下權限檢查一律回 ask、幾乎都退回原生；使用者決定 0.2.1 起背景命令與 Monitor 一律走原生，相關程式已移除。
- 權限對話框真的出現時，pane 狀態正確變成 blocked（之前沒實機測過的那一項）。
- herdr 外（清掉 `HERDR_*`）：沒有任何 herdr 工具、herdr agent 類型，系統提示也沒有 herdr-commander。

### 0.2.1 實機確認（2026-10-05）

- 背景 Bash 在 herdr 裡走原生（回原生的 task id `bj4vy80jy`）。
- Agent 開的 Claude worker 收到的第一行就是任務本身（`Count the files directly inside D:\Tool\HerdrCommander\hooks.`），不是 `[herdr-job` 開頭，多行與反斜線都完整；它用 SendMessage 回報，commander 收到訊息與完成通知。
- 抓到並修正：拿掉開頭之後，worker 第一次只在畫面上回答、沒有回報 → 查出 mod 的系統提示段落被安全 plugin 略過（0.1.0 起就是），改成附在訊息的 context；剛開好的 Claude worker 收到多行任務時吃掉 Enter、任務停在輸入框 → Claude 也套用補 Enter（修正後那次的紀錄是 `nudged: true`，任務正常送出）。

## 已知限制與未做項目

- herdr worker 不會出現在 Claude Code 原生的背景任務清單、不會觸發 SubagentStart／SubagentStop；通知的外觀和原生不同，要等 session 閒下來才送到。
- Agent 只接管兩個 herdr 類型；`general-purpose`、`Explore` 等其他類型照原生跑（已定）。背景命令與 Monitor 也一律原生（已定）。
- 「讓 Claude 感覺不到 herdr」（例如 worker 的系統提示、通知外觀）這版沒做。
- worker 被手動關掉 pane 時，它開著的 job 不會自動結束，要用 TaskStop。
- 派工者在 worker 正在忙（working）時送來的訊息，如果 Enter 被吃掉不會補（只在 pane 沒進入 working 時才補）。
- 兩個 bridge 行程同時對同一個 worker 動作（例如派工者送訊息的同一刻 worker 完成）沒有鎖，只在完成和第一次送出前重讀狀態，縮小時間窗。

- **沒做**：Codex App Server bridge（官方仍標 experimental，未經你同意不引入）、`events.subscribe` 推播（CLI 沒有對應指令，要另寫連 `herdr.sock` 的程式；目前用輪詢）、`herdr_worktree` 工具、ACK／去重的完整訊息協定（P2，目前只靠 job_id＋結果檔）。
- **沒實機測**：
  - 互動式的權限對話框 → blocked：程式改用 `classic.PermissionRequest`，但沒有真的觸發一次。
  - P2～P4 的開關在 mod 端只跑了單元測試，因為要開它們得寫 `settings.json`。bridge 的背景指令有實機測。
  - Codex dashboard 的 `wakePending` 與 Codex 結束時釋放 lease：有單元測試，沒有實機看過。
  - 從 Claude commander 直接開 Claude worker（反方向的 Codex commander → Claude worker 有測）。
- 每次 herdr 呼叫約 1.2 秒；commander 模式下輪詢與預覽會持續有 node 行程。
- `agent read` 讀不到 alternate screen 已捲走的內容，所以結果一律走檔案。
- `<runtime>/<ws>/owned.json` 若 pane 是被手動關閉的，會留下過期項目（不影響功能）。
- D4（Codex 的 herdr integration）仍待你決定；目前 Codex 狀態靠 herdr 讀畫面。

## 給 review 的重點

- `bridge/lib/ops.mjs`：所有 herdr 操作與規則（禁止清單在 `lib/herdr.mjs`）。
- `hooks/register.tsx`：所有用到 `$` 的程式。引擎規定 `$` 不能跨 import 傳遞、state atom 必須宣告在同一檔，所以集中在這裡；純函式在 `hooks/pure.ts`。
- `codex/herdr-codex.ps1` → `bridge/cli.mjs codex-launch`：Codex 的參數交給 node 去 quote，因為 PowerShell 5.1 會弄壞含引號的 native 參數。
