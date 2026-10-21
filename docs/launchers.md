# 啟動器：讓任何插件接上 herdr worker

herdr-commander 開 Claude worker 時，預設是在新的 herdr pane 裡打 `claude`。有些插件要換一種方式啟動 Claude，例如 SkillPool 要用 `skillpool <profile>` 先把 profile 的 plugin、MCP、skill、規則和記憶準備好。**啟動器**就是用來描述這種啟動方式的 JSON 檔。放一個檔進登記資料夾，下一個 session 就能用：

- `herdr_worker_spawn` 會多出 `launcher` 和 `params` 兩個參數；
- 啟動器如果有「選項清單」，Agent 清單裡每個選項會多一個 agent 類型，例如 `herdr-commander:skillpool-h5-slot`。

herdr-commander 不認得任何插件的名字，只照檔案內容做事。所以接上新插件不用改 herdr-commander，插件本身也不用知道 herdr。

---

## 1. 放在哪裡

```
%LOCALAPPDATA%\herdr-commander\launchers\<name>.json
```

- 一個檔就是一個啟動器，檔名（不含 `.json`）就是啟動器的名字。
- 只讀這一個使用者層的資料夾。專案資料夾裡的檔案**不會**被當成啟動器，所以 clone 一個 repo 不會被偷偷加進啟動器。
- 改完檔案後，要等新開的 session（或 `/reload-plugins`）才會生效。Agent 類型和工具說明是在 session 啟動時讀的。
  - session 啟動時，會先讀上一次的清單快取（`runtime\launchers.json`），讓第一輪就有 agent 類型；接著在背景重新讀登記表、執行選項指令。
  - 所以剛新增的啟動器，在第一個新 session 裡大約要幾秒後才出現；之後的 session 從第一輪就有。

### 安全：這個資料夾的信任等級跟 settings 的 hooks 一樣

檔案裡的 `command` 會在開 worker 時打進 pane 執行，`choices.command` 則在**每個** commander 或 plain session 啟動時執行。所以這個資料夾等於一個能執行程式的入口：

- 只放你看得懂、信任的檔案。
- 要請 Claude 幫你寫或改這裡的檔案時，Claude 應該先把內容給你看、等你同意才寫入。
- 模型能決定的只有參數值，而且每個值都必須符合該參數的 `pattern`。模型沒辦法自己組指令，也沒辦法加參數。

---

## 2. 檔案格式

```json
{
  "name": "skillpool",
  "description": "Start the worker under a SkillPool profile: the profile's plugins, MCP servers, skills, rules and memory",
  "kind": "claude",
  "command": ["skillpool", "{profile}"],
  "env": {},
  "params": {
    "profile": {
      "pattern": "^[a-z0-9][a-z0-9-]{0,40}$",
      "description": "SkillPool profile name",
      "required": true,
      "choices": {
        "command": ["skillpool", "list", "--json"],
        "value": "name",
        "description": "description",
        "exclude": "errors"
      }
    }
  }
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `name` | 否（預設用檔名） | 小寫英數字和 `-`，最多 31 字。**必須跟檔名一樣**；不能叫 `claude` 或 `codex`。 |
| `description` | 是 | 給模型看的一句話：這個啟動器做什麼、什麼時候用。會出現在 `herdr_worker_spawn` 的說明和 agent 類型的說明裡。建議寫英文，跟其他工具說明一致。 |
| `kind` | 否 | 目前只支援 `"claude"`（啟動的必須是 Claude Code）。 |
| `command` | 是 | 取代 `claude` 的那串指令，一個元素就是一個參數。可以用 `{參數名}` 放參數值。不能含雙引號 `"` 或控制字元。 |
| `env` | 否 | 開 pane 時多帶的環境變數，`{"名稱": "值"}`，值可以用 `{參數名}`。不能以 `HERDR_` 開頭。 |
| `params` | 否 | 參數表，見下。`command` 和 `env` 用到的每個 `{x}` 都必須在這裡宣告，宣告的每個參數也都必須被用到。 |

### 參數（`params.<名字>`）

參數名是小寫英數字和 `_`，以字母開頭。

| 欄位 | 必填 | 說明 |
|---|---|---|
| `pattern` | 是 | 正規表示式，**必須以 `^` 開頭、`$` 結尾**，值必須整個符合。這是唯一擋住模型亂填的地方，請盡量寫窄。 |
| `description` | 否 | 給模型看的參數說明。 |
| `required` | 否 | 預設 `true`。設成 `false` 時，沒給值的話，`command` 中含這個 `{x}` 的元素和 `env` 中含它的變數會整個拿掉。 |
| `default` | 否 | 沒給值時使用的預設值，也必須符合 `pattern`。 |
| `choices` | 否 | 可以選的值，見下。 |

### 選項清單（`choices`）

有兩種寫法：

1. **固定清單：** `["a", "b"]` 或 `[{"value": "a", "description": "說明"}]`。
2. **指令：** 執行一個會輸出 JSON 陣列的指令。
   - `command`：要執行的指令。透過 shell 執行，所以 `.cmd` shim 也能用。不能含 `" % ^ & | < >`。逾時 15 秒。
   - `value`：值要讀哪個欄位，預設 `"value"`。陣列元素本身是字串時，就直接當作值。
   - `description`：說明要讀哪個欄位，也可以給一個欄位清單，會用 ` · ` 串起來。預設 `"description"`。說明超過 200 字會截斷。
   - `exclude`：選填的欄位名。那個欄位有值（非空陣列或 true）的項目會被排除，例如 SkillPool 的 `errors`。

不符合 `pattern` 的選項會自動略過。指令失敗時，那個參數就當作沒有選項：不會註冊對應的 agent 類型，但 `herdr_worker_spawn` 照樣可以用。

**什麼時候會產生 agent 類型：** 啟動器裡剛好只有一個參數有選項，而且其他參數都是選填或有預設值時，每個選項會註冊一個 agent 類型 `herdr-commander:<啟動器>-<值>`。名稱超過 64 字或含不合法字元的選項會略過。

---

## 3. 啟動器怎麼被用

### `herdr_worker_spawn`

```json
{ "cwd": "D:\\H5\\H5_CLIENT_Super8", "task": "…", "launcher": "skillpool", "params": { "profile": "h5-slot" } }
```

- 有帶 `launcher` 時，`cwd` 可以是這個 session 自己的資料夾；沒帶的話仍然會拒絕自己的資料夾，那種情況請改用 Agent。
- 工具說明裡會列出所有啟動器、各自的參數和可以選的值。
- 這個工具預設藏在 ToolSearch 後面，模型要先用 `ToolSearch`（`select:mcp__herdr-commander__herdr_worker_spawn`）載入，才看得到說明和參數。沒有選項的啟動器（例如下面的 `haiku`）不會產生 agent 類型，只能從這裡用，所以要用時直接請 Claude 載入這個工具。

### Agent

```
subagent_type: herdr-commander:skillpool-h5-slot
```

worker 開在 commander 自己的資料夾，其他行為跟 `herdr-commander:claude-worker` 一樣：最後一則回覆會以跨 session 訊息送回來，SendMessage 接續同一個 job，TaskStop 關掉 pane。

注意，插件自己可能也有同名的 in-process agent，例如 SkillPool 的 `skillpool-h5-slot`。兩者不同：

| | `skillpool-h5-slot`（插件的原生 subagent） | `herdr-commander:skillpool-h5-slot`（啟動器） |
|---|---|---|
| 在哪跑 | 同一個 session 內 | 獨立的 herdr pane，另一個 session |
| 設定 | 近似：主線的 plugin 和 skill 清單照舊 | 完整：啟動器負責的一切都套用 |
| 成本 | 便宜、快 | 另外花一個 session 的額度 |
| 適合 | 短的、讀寫為主的任務 | 長的、需要乾淨設定的任務 |

### 實際打進 pane 的那一行

```
<command 的每個元素> [--plugin-dir '<開發版路徑>'] [--model <model>] [--permission-mode <mode>]
```

- herdr-commander 原本要給 `claude` 的參數，會接在啟動器指令後面；啟動器要負責把它們轉交給 `claude`。SkillPool 的 launcher 就是這樣做的。
- **優先順序：** 這些接在後面的參數，在 SkillPool 裡比 profile 的設定優先。例如 Agent 呼叫時給了 `model`，就會蓋過 profile.json 的 model。其他啟動器怎麼處理，看它自己的規則。
- **引號規則（pane 的 shell 是 PowerShell 5.1）：**
  - 元素只含英數字和 `. _ : / \ = + -` 時，原樣放進去；
  - 其他元素用單引號包起來，內部的 `'` 寫成 `''`；
  - 第一個元素如果被加了引號，前面會補 `& `。
  
  所以帶空白的路徑可以用，例如 `"C:\\Program Files\\x\\a.exe"`，但雙引號一律不能用。
- pane 的環境變數（`HERDR_ENV`、`HERDR_PANE_ID`、`HERDR_COMMANDER_ROLE=worker` 等）會原樣傳下去。啟動器**不能**清掉它們，worker 的 herdr-commander 要靠它們運作。

---

## 4. 範例

### SkillPool profile（完整檔）

檔案內容見第 2 節，放到 `%LOCALAPPDATA%\herdr-commander\launchers\skillpool.json` 就好。SkillPool 本身不提 herdr，跟 herdr 有關的事都記在這裡。SkillPool 對外保證的只有兩件事：

- 任何工具改成執行 `skillpool <profile> [claude 參數…]`，就能套用那個 profile；
- `skillpool list --json` 的 `name`、`description`、`whenToUse`、`errors` 是穩定介面（`path`、`skills` 不保證）。

**用 SkillPool 開 worker 的注意事項：**

- **profile 不能關掉 herdr-commander。** 關掉的話，worker 起得來，但永遠不會回報 session，任務也送不進去（見第 5 節）。具體來說：
  - `plugins.off` 不要列 herdr-commander；
  - 用 `mcp.only` 時，要把 herdr-commander 列進去，否則它註冊的工具（例如 `herdr_worker_spawn`）會被擋。這條對 commander 自己的 session 也適用。
- **worker 裡不要中途 `/skillpool <profile>`。** 一律在開 worker 時就帶 profile。中途切換會先跳「加入資料夾」的確認框，pane 會卡在 blocked 等人回答；接著還會壓縮對話。
- **後面接的參數會蓋過 profile 的設定**：Agent 給的 `model`（`--model`）會蓋過 profile.json 的 model；`--name` 也一樣。
- **兩種派工方式**：
  - SkillPool 產生的原生 subagent `skillpool-<profile>`：在 session 內跑，便宜；
  - 這裡的 `herdr-commander:skillpool-<profile>`：獨立 pane，跑完整 profile。
  
  兩者差別見第 3 節的表。只想要 pane worker 時，可以在 profile.json 設 `"agent": false`，關掉 SkillPool 產生的那個原生 agent。
- 程序樹是 `skillpool.cmd → python → claude`，herdr 一樣認得出 Claude（實測 29 秒）。TaskStop 直接關掉 pane 時，SkillPool 的暫存檔會留到下次執行 `skillpool` 時才清掉。

### 固定用某個 model 的 wrapper（沒有參數）

```json
{
  "name": "haiku",
  "description": "A cheap, fast Claude worker on the haiku model, for small mechanical edits",
  "command": ["claude", "--model", "haiku"]
}
```

沒有參數就沒有選項，所以不會產生 agent 類型，只能用 `herdr_worker_spawn` 的 `"launcher": "haiku"`。

### 從固定清單挑一個 settings 檔

```json
{
  "name": "settings",
  "description": "A Claude worker with one of the prepared settings files (permissions, hooks)",
  "command": ["claude", "--settings", "C:/Users/me/.claude/worker-settings/{preset}.json"],
  "params": {
    "preset": {
      "pattern": "^(readonly|reviewer)$",
      "description": "which settings file",
      "choices": [
        { "value": "readonly", "description": "read-only tools only" },
        { "value": "reviewer", "description": "review: read, git and tests" }
      ]
    }
  }
}
```

這個會產生 `herdr-commander:settings-readonly` 和 `herdr-commander:settings-reviewer` 兩個 agent 類型。

### 反例：只用 `env` 接 SkillPool

```json
{ "name": "skillpool-env", "description": "…", "command": ["claude"], "env": { "AGENT_PROFILE": "{profile}" }, "params": { "profile": { "pattern": "^[a-z0-9-]+$" } } }
```

**不要這樣寫。** 這樣只有 SkillPool hook 塞進來的規則和記憶，沒有 skill 連結，SkillPool 的 mod 也不會啟用，只是半套 profile。插件有自己的 launcher 時，就用它的 launcher 當 `command`。

---

## 5. 檢查與除錯

### 看登記表讀到了什麼

```powershell
node "$env:USERPROFILE\.claude\plugins\cache\herdr-commander\herdr-commander\<版本>\bridge\cli.mjs" launchers
```

（開發版的話是 `node D:\Tool\HerdrCommander\bridge\cli.mjs launchers`）

輸出包括：
- `launchers`：讀到的啟動器，每個參數的 `choices` 已經實際跑過；
- `agent_param`：用來產生 agent 類型的那個參數；
- `errors`：沒讀進來的檔案和原因，例如「name must be the file name」、「pattern must be … anchored」、「{x} is not one of its params」。

### 常見狀況

| 症狀 | 原因與處理 |
|---|---|
| Agent 清單沒有新類型 | session 啟動時才讀登記表，請新開 session 或 `/reload-plugins`。也看看 `launchers` 輸出裡的 `errors`、`choices_error` 和 `agent_param`。 |
| `bad_params … must match …` | 模型填的值不符合 `pattern`。 |
| `no claude agent detected in wA:pN (started by launcher X) … the pane's last lines: …` | 啟動器沒把 Claude 帶起來，例如 profile 不存在、launcher 以錯誤結束。最後幾行就是 pane 上的錯誤訊息。 |
| `… has run for over 180 s without reporting its Claude session … started by launcher X, whose settings may switch herdr-commander off` | Claude 起來了，但 worker 裡沒有 herdr-commander。通常是啟動器的設定把它關了，例如 SkillPool profile 的 `plugins.off` 有 herdr-commander，或用了 `mcp.only` 卻沒列它。**用啟動器開的 worker 必須讓 herdr-commander 保持啟用。** |
| worker 卡在確認框（blocked） | 啟動器開出來的 Claude 在等人回答，例如資料夾信任、加資料夾。到那個 pane 回答就好。 |

---

## 6. 給 Claude 的做法：幫新插件接上 herdr

做插件時，如果需要讓 worker 以這個插件的方式啟動：

1. 先確認插件有自己的啟動指令，而且會把後面的參數轉交給 `claude`。沒有的話，先在插件裡做一個。
2. 依第 2 節寫一份 `<name>.json`：
   - `description` 寫英文，說明什麼時候該用；
   - 每個參數的 `pattern` 盡量寫窄；
   - 有現成的「列出可選值」指令時，用 `choices.command`，用 `value`、`description` 指定欄位，不要求插件改輸出格式。
3. **把檔案內容給使用者看，取得同意後**才寫進 `%LOCALAPPDATA%\herdr-commander\launchers\`。
4. 跑第 5 節的 `launchers` 指令，確認 `errors` 是空的、`choices` 正確。
5. 請使用者新開一個 session，用 `herdr_worker_spawn` 或新的 agent 類型開一個 worker 測試：pane 起得來、worker 有回報 session（`runtime\<workspace>\workers\*.json` 裡有 `session_id`）、任務送得到。
6. 啟動器檔和「搭配 herdr 時的注意事項」都寫在本文件第 4 節，新增一個範例小節，插件那邊不用提 herdr。插件只需要讓它的啟動指令和選項清單的輸出格式保持穩定。SkillPool 就是這樣做的。
