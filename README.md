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

更新：版本號在 `.claude-plugin/plugin.json`（目前 `0.3.0`）。**只有改了版本號，`claude plugin update` 才會更新**；更新後在 session 內跑 `/reload-plugins`。

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

### 在 herdr 裡，Claude 的原生工具走 herdr（0.2.0 起，總開關 `takeover`，預設開；本節是 0.3.0 的行為）

模型照常用 Claude 原生工具，由 mod 在背後接管；自訂的 herdr 工具只剩一個 `herdr_worker_spawn`。

| 原生工具 | 在 herdr 裡變成 |
|---|---|
| Agent，`subagent_type` 是 `herdr-commander:claude-worker` 或 `herdr-commander:codex-worker` | 在 commander 所在的資料夾旁開一個 herdr pane，裡面跑 Claude 或 Codex worker。立刻回「已在背景啟動」，id 是 `herdr-agent-<workspace>-<6 碼>`，outputFile 是 bridge 維護的 Markdown 紀錄（任務、雙方訊息、每次 Read 時的最新畫面）。**其他類型（Explore、general-purpose 等）、fork、remote 一律照原生，不開 pane（使用者已定）** |
| SendMessage | worker 傳給 `main`（或派工者的 pane id／名字）：原樣立刻轉給派工者，當作中途報告（不算交件）；派工者是 Claude 時用跨 session 訊息寄過去。派工者傳給 worker（herdr id、名字、pane id）：併進進行中的 job；上一個 job 已完成就重新打開同一個 job；worker 正忙別人的 job 就排隊。目標是 bridge 開的 Claude worker 時當場用跨 session 訊息寄出，工具結果會說「已送達」「等 worker 起來再寄」或「送不到：原因」。不看訊息內容 |
| TaskStop（herdr id，或自己開的 worker 的名字／pane id） | 送 Ctrl+C、關掉 pane，**不問人**；別人開的 pane 一律拒絕 |
| ListAgents | 原生清單後面接著列：自己開的 herdr worker（id、名字、狀態、目前的 job、排隊數、資料夾、輸出檔），以及其他 herdr pane 的畫面檔路徑 |
| Read 執行期資料夾裡的檔案 | 先由 bridge 刷新（worker 輸出檔補上最新畫面；`panes\<pane>.txt` 寫入該 pane 畫面），再交給原生 Read；這個資料夾的 Read 不跳權限詢問 |
| 背景 Bash／PowerShell（`run_in_background`）、Monitor | **不接管，一律是 Claude 原生**（在 herdr 裡也一樣，使用者已定） |
| `herdr_worker_spawn`（唯一保留的工具，commander／plain） | 在**別的**資料夾開 worker（`cwd`、`kind`、`task` 必填，`name` 選填）；給這個 session 自己的資料夾會被拒，請改用 Agent |

Claude worker 怎麼收到工作（0.3.0 起）：bridge 開的 Claude worker、由 Claude 派工者（有這個 mod 的 Claude session）派工時，任務和之後用 SendMessage 送來的訊息都走 **Claude Code 內建的跨 session 訊息**，不再打字進輸入框：
- worker 的 mod 啟動時（以及 `/clear`、`/resume` 換對話後）把自己的 session id 交給 bridge，記在它的 worker 紀錄上；派工者的 mod 在 Agent、`herdr_worker_spawn`、SendMessage 時帶上自己的 session id，記在 job 上（每次都更新，派工者換過對話也找得到）。
- bridge 不打字，只把 job 標成「待寄」（`pending`），保存要寄的內容：訊息本身，不加任何標頭；第一份是任務加上還沒送的訊息。沒有長度限制，也不走任務檔（不經命令列）。
- 派工者的 mod 寄出：SendMessage 被接管時當場寄，Agent 開好 worker 時寄一次，輪詢時有待寄的也寄。取走的同時 bridge 先記送達時間、狀態改成「寄送中」（`sending`），寄完再回報。先記時間的原因：worker 可能在 mod 回報之前就收到、做完、結束這一輪，而完成判斷要看「這一輪有沒有收到最新的送達」。
- worker 收到的是一則跨 session 訊息：閒置時會開新的一輪，忙碌時在它下一次工具結果後面送進去；模型知道這不是使用者打的。
- **送不到時絕對不改回打字**（使用者決定）：撤回這次送達（訊息回到未送）、job 標成「送不到」（`undeliverable`）並記一筆事件帶原因，SendMessage 的工具結果直接說「送不到：原因」，由派工者決定重送、TaskStop 或問人。之後再 SendMessage 給同一個 worker，會接續同一個 job 重送。worker 開始跑之後超過 60 秒都沒回報 session id，也算送不到。
- 權限模式：目前**讀不到派工者即時的權限模式**，worker 用使用者設定的預設模式啟動。派工者如果用 shift+tab 或 `--permission-mode` 改過模式，雙方模式不同，跨 session 訊息可能會被擋下等人同意。（原本打算從 classic hook 輸入的 `permission_mode` 取，但實機 debug log 顯示 `classic.SessionStart`、`classic.UserPromptSubmit` 都被內建安全 plugin 略過，永遠不會跑，所以拿掉了。帶 `permission_mode` 給 bridge、bridge 加 `--permission-mode` 的程式還在，只是現在沒有來源給它值。）
- 派工者的模型照通知裡的 `from=` 地址直接回 worker（不經 SendMessage 的接管，bridge 本來看不到）：worker 的 mod 在 `session.receive` 收到別的 session 的模型寫的訊息時（不是這個 plugin 自己寄的），把原文和收到的時間交給 bridge，一律當作這個 worker 的派工者傳來的：有進行中的 job 就附加進去；沒有就重新打開派工者最近一個已完成的 job；都沒有就不記。送達時間用 worker 收到的時間，所以這一輪結束時照常算完成、照常把結果寄回派工者。
- 寄送中卡住：派工者的 mod 取走之後超過 60 秒都沒回報寄送結果（例如程序中途停了），下次取件時標成送不到，原因是「寄送結果一直沒有回來，訊息可能到了、也可能沒到，重送前先 Read worker 的輸出檔」。這種情況不撤回送達，worker 如果其實收到並回覆了，job 照常完成。

Codex worker、Codex 派工者（Codex commander 開的 Claude worker 也算）、不是 bridge 開的 Claude pane，照舊打字：bridge 開的 Claude worker 直接收到內容本身（超過 30,000 字、含終端機控制碼、或第一個字是 `/`、`!`、`#` 時改成「寫進任務檔＋一行提示」；上限依 Windows 命令列 32,767 個 UTF-16 字元，實測 31,081 字送達、33,000 字失敗），其他收一行 `[herdr-job …]` 提示加任務檔。打字送出後幾秒內 pane 沒進入 working，就補一次 Enter。

worker 怎麼知道怎麼交件：mod 把說明附在 worker 收到的每則訊息上（跨 session 訊息也會觸發 worker 的 `prompt.submit`）（「做完或需要決定時，把結果寫在回覆裡、結束這一輪；最後一則回覆會交給派工者；中途想報告可以 SendMessage 給 main」，不要求任何格式），當作模型看得到、使用者看不到的 context（commander 的規則則在每個角色的第一則訊息附上一次）。原因是實測時內建的安全 plugin 會略過使用者層 plugin 的 `prompt.compose`（debug log：`herdr-commander: prompt.compose bypassed by cc-plugin-sec-default`），只靠系統提示的話模型根本看不到。

job 怎麼算完成（0.2.2 起，照原生背景子代理）：**Claude worker 一輪正常結束時的最後一則回覆就是結果。** worker 自己的 mod 在主迴圈一輪結束時，把引擎給的 `reason`、`isAborted` 和最後回覆 `answer` 交給 bridge（answer 走 stdin，不經命令列，所以超過 Windows 命令列 32,767 字的回覆也完整）。bridge 只看這些和自己的紀錄：
- 這個 pane 有開著的 job，而且這一輪有收到這個 job 最新的那次送達（看這一輪的開始時間，或這一輪中途收到的最後一則 prompt 的時間，不早於送達時間；「中途收到」這種情況沒有實機測過）：
  - `reason` 是 `answer`、沒被中斷、回覆不是空的 → 回覆記成 worker 的訊息、寫進結果檔，job 完成（`completed_via: answer`），只產生一筆 `completed` 事件。派工者只收到**一則**通知，說它做完了、結果在哪個檔（最後一段是它的最後回覆），請派工者去讀，再加上「SendMessage 給它接續同一個 job；TaskStop 關掉它的 pane」。通知本身不帶 worker 寫的內容（見下面「通知只說去讀哪裡」）。
- 還有待寄的訊息（`pending`）、或這個 job 的訊息根本沒送到過 worker（送不到且撤回）→ 這一輪不算這個 job，什麼都不做。
  - 被中斷、refusal、error、回覆是空的 → 不完成；派工者只收到一次「停下來了，但沒有交出結果」（事件 `stopped_without_answer`）。
- 沒有開著的 job（job 已完成，或使用者自己在 worker 的 pane 打字）→ 什麼都不做，不轉給 commander。

worker 中途用 SendMessage 傳給 main 的訊息照樣立刻轉給派工者（一則「傳了訊息」通知），但不算交件；那一輪結束時仍用最後一則回覆完成。之前（0.2.1）要「傳過 SendMessage＋停下來」才算完成，每次交件派工者都會收到兩則通知（先「傳了訊息」，3～25 秒後「完成了」），第二則沒有新資訊卻讓 commander 多跑一輪；而且我們接管的是 Agent 工具，照原生背景子代理的做法比較一致，所以改掉。

交件通知怎麼送到派工者（0.3.0 起）：
- 跨 session 的 job（上面的範圍）：worker 中途 SendMessage 給 main、以及一輪結束時的「完成（附回覆）」或「停了沒交結果」，都由 **worker 的 mod 用跨 session 訊息寄給派工者**。bridge 決定完成與否後，回傳派工者的 session id 和事件資料，worker 的 mod 用跟派工者自己的通知同一份文字（`hooks/pure.ts` 的 `eventText`、`noticeText`，兩邊共用）寄出，再回報結果。bridge 不能 import TypeScript，所以回傳的是資料、文字由 mod 組。
- 防重複：bridge 回傳時就把那個事件標成「由 worker 寄送中」（`relay: sending`）；寄成功標成已寄（`sent`）。派工者的 mod 輪詢時跳過已寄的、以及寄送中且未滿 30 秒的；寄失敗（`failed`）或超過 30 秒沒結果，就照舊由派工者的 mod 在閒下來時用 plugin 訊息補通知（備援，不經輸入框）。派工者在等這種事件時會繼續輪詢。
- 其他通知（Codex worker 完成、worker 開不起來或卡在信任對話框、送不到、worker 寄失敗的補通知）由派工者自己的 mod 輪詢後送：
  - 派工者閒著：用 plugin 提示詞送進來，開新的一輪。
  - 派工者這一輪還在跑：先留著，**附在它下一次工具呼叫的結果後面**（工具結果的 context，模型當場讀到、使用者看不到），不用等這一輪結束。這一輪如果沒有再呼叫工具就結束，結束時改用提示詞送。2026-10-19 實機確認：Codex worker 01:24:34 完成，派工者在同一輪的第 18 次工具結果（`Get-Date`）就讀到通知，debug log 裡沒有另外送提示詞。
  - 試過、不能用：plugin 寄跨 session 訊息給自己的 session，引擎會拒絕（`no live session on this machine has id <自己的 id>`）。
  - SendMessage 當場寄失敗的那次已經寫在工具結果裡，不會再通知一次。
- 通知只說去讀哪裡（2026-10-19 使用者決定，把通知和內容拆開）：通知不帶 worker 寫的內容（包括 Codex 的一行摘要），只說誰、哪個 job、發生什麼事，以及去讀哪個檔：job 完成指向結果檔，中途訊息指向 worker 輸出檔裡最新的一段「worker → sender」。Claude worker 寄給派工者的跨 session 訊息用同一份文字。唯一例外：不是 bridge 開的 pane 中途傳來的訊息沒有輸出檔可指，照舊附原文。

一個 worker 一次只做一個 job，其他 job 排隊；想平行就多開幾個 worker。

Codex 端不變：Codex commander／worker 照舊用 `bridge/mcp.mjs` 的 MCP 工具（`herdr_job_complete`、結果檔帶 `job_id:` 檔頭）。排隊、重新打開 job 由 bridge 處理，Codex 一樣適用。

### 換對話（`/resume`、`/clear`）之後照樣在 herdr 裡（0.2.3 起）

mod 的狀態（`$.state`）是跟著對話走的，而 `session.start` 每個程序只在啟動時跑一次。所以「程序先啟動、再切到別的對話」時（先開 `claude` 再 `/resume`、不帶 id 的 `claude --resume` 選單、`/clear`），新對話的狀態是空的。0.2.2 以前這時會一直以為「不在 herdr 裡」，Agent、SendMessage、ListAgents、`/commander` 全部無聲地退回原生。

0.2.3 起：
- 讀到「不在 herdr」時，會再看一次這個程序的環境變數（`HERDR_ENV`、`HERDR_PANE_ID` 等，程序內只讀一次），在 herdr 裡就當場補回來。
- commander 角色看 bridge 的 lease：lease 還是這個 pane 的，就恢復 commander（擋編輯、輪詢、面板）。
- 換對話時（`session.end` 的 `reason` 是 `clear` 或 `resume`）不釋放 lease，也不通知 herdr「agent 走了」，因為程序還在；真正離開（`/exit` 等）才釋放。
- 新對話的模型會重新收到一次 herdr 說明；輪詢重新開始，派出去還沒完成的 worker 的通知照樣會送到。
- 代價：剛好在切換那一刻發生的 job 事件，兩邊對話都不會收到通知（新對話會先把現有事件記成「已看過」，避免把舊通知全部重送一次）。
- 換過去之後，畫面上原本的 Commander 面板會先顯示空的，等新對話第一個動作（送出提示或叫用工具）才更新。

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
- job 完成的證據（都是 bridge 的紀錄與引擎給的結束原因，不看文字格式）：Claude worker 自己的 mod 回報這一輪以 `answer` 正常結束、沒被中斷、回覆不是空的（回覆本身就是結果）；Codex worker 呼叫 `herdr_job_complete`（帶 `result` 全文，由 bridge 寫成結果檔），或結果檔帶檔頭 `job_id: <id>`。agent 的 idle／done／unknown 一律不算完成；送達失敗記為 `delivery_unknown`，不自動重送。
- 完成時通知派工者一次（job 的 `woken`）：Claude 派工者由 mod 自己輪詢喚醒（跨 session 的 job 由 worker 的 mod 直接寄，失敗或 30 秒沒結果才由派工者的 mod 補）；Codex 派工者在 idle 時收到一行 prompt，忙碌時由它的 MCP server 每 10 秒重試。
- 跨 session 的 job 送不到時，**不會改成打字進 worker 的輸入框**：job 標成「送不到」並附原因，由派工者決定。跨 session 訊息只由 mod 寄（`$.session.send`），bridge 只記錄寄給哪個 session、寄什麼；mod 自己寄的訊息不會再被自己的 `session.send` hook 轉回 bridge。
- worker 開起來就卡在 prompt（資料夾信任、登入）時，不送任務，回報 `blocked`，由你到那個 pane 處理。
- MCP 只走 STDIO，沒有網路 listener。

## 測試

```powershell
cd D:\tool\HerdrCommander\bridge; node --test test/bridge.test.mjs   # 63 項，假 herdr，不碰實機
cd ..; claude plugin validate .; claude plugin test .                            # 49 項；validate 也會檢查 marketplace.json
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

### 0.2.2 實機確認（2026-10-05）

在臨時 workspace（`w14`，從 `D:\Tool` 用 `claude --plugin-dir 'D:\Tool\HerdrCommander'` 啟動，測完整個關掉）：

- Agent 開 Claude worker 列出 `hooks` 的檔案：commander 只收到**一則**通知「finished job … Its final reply:」，內容就是 worker 的回覆，後面接「SendMessage to … continues the same job; TaskStop … closes its pane.」。
- commander 用 SendMessage 再交代四次：每次都重新打開同一個 job，每次完成又只有一則附內容的通知。
- 對 worker 按 Esc：沒有完成，commander 只收到一則「stopped without handing you a result」。
- job 紀錄：同一個 job 6 筆 `completed`（都是 `via: answer`，各自帶 `message_seq`）、1 筆 `stopped_without_answer`（`reason: aborted`），**沒有任何 `message` 事件**。
- 抓到（0.2.1 就有，這版沒改）：第一次送任務時剛開好的 worker 吃掉 Enter，紀錄 `nudged: true` 但文字仍留在輸入框，手動補一次 Enter 才送出。
- 沒測到：派工者在 worker 一輪進行中追加訊息（那次訊息到的時候 worker 已經做完，變成重開 job）。

## 已知限制與未做項目

- herdr worker 不會出現在 Claude Code 原生的背景任務清單、不會觸發 SubagentStart／SubagentStop；通知的外觀和原生不同。Claude worker 交給 Claude 派工者的是跨 session 訊息；其餘通知在派工者忙碌時附在下一次工具結果後面，所以派工者卡在一個很久的工具上（例如跑 10 分鐘的測試）時，要等那個工具結束才看到。
- 跨 session 訊息「送達」只代表進了對方的佇列：雙方權限模式不同而被擋下等使用者同意時，結果仍是送達，bridge 偵測不到。目前讀不到派工者即時的權限模式，worker 用使用者設定的預設模式啟動；派工者用 shift+tab 或 `--permission-mode` 改過模式時，就可能發生這種情況。
- SendMessage 送不到時，工具結果是 `{ success: false, message }`；SendMessage 的輸出型別是 `unknown`，核心收不收 `success: false` 沒有實機確認過（`success: true` 有）。
- Agent 只接管兩個 herdr 類型；`general-purpose`、`Explore` 等其他類型照原生跑（已定）。背景命令與 Monitor 也一律原生（已定）。
- 「讓 Claude 感覺不到 herdr」（例如 worker 的系統提示、通知外觀）這版沒做。
- worker 被手動關掉 pane 時，它開著的 job 不會自動結束，要用 TaskStop。
- 打字送達的情況（Codex worker 等），派工者在 worker 正在忙（working）時送來的訊息，如果 Enter 被吃掉不會補（只在 pane 沒進入 working 時才補）。
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
