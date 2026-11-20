# 論文伴讀（paper-reader）

仿 Moonlight 的本機論文閱讀器，只給自己用：伺服器只綁 `127.0.0.1`，所有 PDF 與 AI 產出都存在這台電腦。
AI 功能透過本機的 Claude Code CLI（`claude -p`）執行，不需要 API 金鑰，用量計入 Claude 方案。

## 啟動

雙擊桌面的「論文伴讀」捷徑（或 `start.cmd`、`python server.py`），瀏覽器會自動開啟 <http://127.0.0.1:8791>。
伺服器的命令視窗會縮到工作列，關掉它就停止。已經在執行時再點捷徑，只會開瀏覽器，不會開第二個伺服器。

## 在 Chrome 開啟 PDF

安裝隨附的 [Chrome 擴充功能](chrome-extension/README.md) 後，開啟 PDF 時，左下角會出現「用論文伴讀開啟」提示列。點選後會下載並匯入本機書庫；按「×」關閉、按「⋯」設定是否顯示提示，也能從工具列手動開啟。第一次使用請到 `chrome://extensions/` 開啟開發人員模式，載入 `chrome-extension` 資料夾。

Windows 可再雙擊 `install-browser-launcher.cmd`，貼上 Chrome 顯示的擴充功能識別碼，完成一次性安裝。之後點「用論文伴讀開啟」會自動檢查閱讀器，未啟動時就在背景啟動，無需先點桌面捷徑。已執行的閱讀器會繼續沿用，沒有額外的登入自啟動或常駐啟動服務。

## 存到 PaperBrain

筆記面板的「存到 PaperBrain」會把這篇的整理寫進 `Documents\PaperBrain\paper-reading\<citekey>.md`
（citekey＝第一作者＋年份＋標題第一個關鍵字，同 vault 的 `citekeyFormat`）：
frontmatter（英文鍵）＋三行摘要、摘要、關鍵字、我的筆記、我的高亮、AI 重點句、AI 解釋；
圖片說明的截圖複製到 `99Attachment\paper-reading\` 並以 `![[…]]` 嵌入。

- 同一篇再存一次會更新同一個檔案。
- 如果那個檔案在上次存入後被改過（例如在 Obsidian 裡編輯），會先詢問才覆蓋。
- 目的資料夾可在「設定」修改。「匯出」按鈕下載的是同一份內容（不含圖片）。

## Skill 筆記（DeepPaperNote／textbook-to-note）

筆記面板上方切到「Skill 筆記」，選一個 skill 後按「產生並存到 Obsidian」：

| Skill | 產出 | 存到 vault |
|---|---|---|
| **DeepPaperNote**（`deeppapernote:deeppapernote`） | 單篇論文深度精讀筆記：原文摘要翻譯、創新點、方法主線、關鍵結果、深度分析、侷限；圖表決策＋lint 品管 | `paper-reading\DeepPaperNote\<citekey>\<citekey>.md`（圖在同資料夾 `images\`） |
| **textbook-to-note**（`textbook-to-note:textbook-to-note`） | 依模板（疾病／藥物／檢查／技術／評估工具／自由結構，或自動判斷）逐條引用的知識筆記；PDF 先用 converter 轉成有頁碼的 markdown，圖片走 QC 閘門 | `paper-reading\textbook-to-note\<主題>.md`（圖在 `99Attachment\paper-reading\`；同名已存在就存成 `<主題> (draft).md`） |

- 在背景跑一個完整的 Claude Code 工作階段（`claude -p --plugin-dir <skill>`，工具只開 Bash/Read/Write/Edit/Glob/Grep/Skill，不載入使用者設定與 hooks），可以繼續閱讀；卡片上會即時顯示執行紀錄，可取消。
- 完成後：卡片有「在 Obsidian 開啟」「預覽」「連結到我的筆記」；這篇論文的 PaperBrain 主筆記（`paper-reading\<citekey>.md`）會自動更新，在「延伸筆記」列出所有 skill 筆記的 `[[連結]]`（主筆記若在 Obsidian 改過就不自動覆蓋）。
- 模型與 effort 可在面板上選，預設值在「設定 → Skill 筆記（預設）」。
- skill 位置：DeepPaperNote 在 `~\.claude\skills\deeppapernote`；textbook-to-note 的 skill 在 `~\.claude\skills\textbook-to-note`，程式在 `~\Tools\textbook-to-note`（環境變數 `T2N_REPO` 可改），轉好的語料在 `~\Tools\textbook-to-note\output\<citekey>\`。
- DeepPaperNote 的圖表中間檔放 `~\dpn_tmp`（Windows 路徑 260 字元限制）；其他中間產物在 `data\papers\<id>\dpn\`、`t2n\`。

## 功能

| 位置 | 功能 |
|---|---|
| 書庫 | 拖放、上傳或**用 DOI／PMID／PMCID 匯入**；上傳後自動產生摘要與關鍵字；**分類**（AI 自動＋手動）；**搜尋**標題／作者／分類／摘要；**閱讀狀態與星號**；**多選批次操作**；**匯出引用**（APA、BibTeX、Zotero RDF）；**回收桶** |
| 工具列 | 目錄、全文搜尋（Ctrl+F）、縮放、頁碼、**自動高亮**、**圖片說明**、**版面翻譯** |
| 選取文字 | 翻譯、解釋、問 AI、五色高亮、加入筆記、複製；選取引用編號（如 `[6,7]`、上標 `1–3`）會顯示對應參考文獻 |
| AI 伴讀 | 關鍵字詞典、三行摘要、結構化摘要、建議問題、對話（可選 Haiku／Sonnet／Opus／Fable） |
| 對照翻譯 | 目前頁面逐段原文＋譯文，點段落跳到 PDF 位置 |
| 解釋 | 所有文字／圖片／表格／公式解釋紀錄，可篩選、加入筆記 |
| 高亮 | 自動高亮（新穎性／方法／結果＋AI 短評）與自己的高亮 |
| 筆記 | 我的筆記：Markdown＋LaTeX，自動儲存；「匯出 Markdown」會連同摘要、關鍵字、高亮一起輸出。Skill 筆記：DeepPaperNote／textbook-to-note，直接存進 Obsidian |
| 測驗 | 5／10／15 題、簡單／困難，四選一附解析與頁碼 |
| 引用卡片 | 本文 BibTeX、參考文獻擷取（附 PubMed／Scholar／DOI 連結） |

- **版面翻譯**：把繁中譯文直接覆蓋在原文區塊上；點一下譯文區塊可暫時看原文。
  譯文會自動放大到填滿原文區塊（中文通常比英文短，最多放大到原文字級的 2 倍），放不下時則縮小；並排檢視相同。
  若 PDF 將公式或段落拆成互相重疊的區塊，該處會保留原文，避免譯文蓋住公式；完整譯文仍可在右側「對照翻譯」查看。並排檢視也採用相同保護。
- **並排檢視**：左邊原文、右邊譯文（同版面），同步捲動；滑到任一邊的段落，兩邊對應段落會一起框起來。收合右側面板可讓頁面變大。
- **頁面旋轉**：工具列頁碼旁的左右旋轉按鈕可將目前頁面旋轉 90°，點擊角度即可還原。每篇文獻各頁的方向會自動儲存；高亮、譯文及並排檢視同步旋轉，原始 PDF 檔案不會改寫。
- **段落解釋**：滑鼠移到段落旁，左邊出現 ✦，點下去解釋那一段（點章節標題會解釋整節）；解釋完頁面上會留一個標題標籤，點標籤跳到該則解釋。
- **圖片說明**：按下後在頁面上拖曳框選圖、表或公式，AI 會讀取截圖並解釋。
- 解釋、對話、選取翻譯都是串流輸出（幾秒內開始出字）；全文翻譯逐段出現。上傳後會在摘要完成時自動在背景翻譯全文（設定可關）。
- 輸出一律繁體中文（台灣用語）。

## 書庫分類與搜尋

- **分類**像資料夾：每篇論文放一個分類，左側清單可篩選、改名、刪除（刪分類不會刪論文，只會移到「未分類」）。
- **AI 分類**：摘要完成後自動把新論文歸入現有分類（設定可關）；左側「AI 分類未分類」一次處理所有未分類的論文，
  「重新整理全部分類」讓 AI 重新設計分類架構（合併、拆分、改名）。分類依臨床主題，不依研究設計。
  第一次分類時也會從首頁擷取完整作者名單，讓作者搜尋找得到第二作者以後的人。
- **手動**：卡片右上角的分類選單直接改，或把卡片拖到左側分類上。手動指定的論文與手動建立的分類，AI 都不會更動。
  卡片上的「AI」小標表示是 AI 分的。
- **搜尋**：輸入即篩選，多個詞用空白隔開（全部都要符合）；可限定範圍為標題、作者、分類、摘要／關鍵字。
  符合的字會標黃；只在摘要或作者名單裡符合時，卡片下方會顯示那一段。按 `/` 跳到搜尋框。
- 分類存在每篇的 `meta.json`（`category`、`category_source`）與書庫的 `library.json`；「存到 PaperBrain」的 frontmatter 會帶 `category`。

## 閱讀狀態、批次操作、回收桶

- **閱讀狀態**：未讀／閱讀中／已讀，卡片右側可改；第一次打開論文自動變「閱讀中」，讀完在閱讀頁工具列標題旁改成「已讀」。**星號**按卡片或工具列的 ☆。
  列表上方的「全部／星號／未讀／閱讀中／已讀」可以和左側分類、搜尋一起篩選。
- **多選**：滑鼠移到卡片左側出現勾選框；Shift 連續選取、Ctrl＋點卡片加選、Ctrl+A 全選目前清單、Esc 取消。
  選取後上方出現批次列：移到分類、標為某狀態、加／取消星號、匯出引用、AI 重新分類（含手動指定的）、刪除。選取的卡片可以一起拖到左側分類或回收桶。
- **回收桶**：刪除會先移到回收桶（`trash\`，跟著書庫同步），畫面下方可「復原」；回收桶裡可還原或永久刪除，不會自動清空。
  重新上傳回收桶裡的同一份 PDF，會直接還原原本的翻譯與筆記。

## 用 DOI／PMID／PMCID 匯入

書庫右上角「用 DOI／PMID 匯入」，每行一筆（也可貼 PubMed、期刊網址）。依序嘗試：

1. Europe PMC、OpenAlex、Semantic Scholar 找到的**出版社開放取用 PDF**（PLOS 等可以直接下載，約 3–8 秒）
2. **PMC 開放取用資料集**（NIH 放在 AWS 的 `pmc-oa-opendata`；從這台電腦下載約 15–30 KB/s，1 MB 約 30–60 秒，會顯示進度）
3. 期刊頁面的 `citation_pdf_url`

Elsevier、Wiley、MDPI 等出版社、以及 NCBI／Europe PMC 自己的 PDF 頁面都有瀏覽器驗證（Cloudflare、reCAPTCHA），程式抓不到；
找不到時會給「在瀏覽器開啟」連結，開啟後用 Chrome 擴充功能「用論文伴讀開啟」或拖曳 PDF。只抓得到免費的 PDF，不會繞過訂閱。

## 匯出引用

批次列「匯出引用」：複製 APA（貼到 Word 保留斜體）、下載 APA（.txt）、BibTeX（.bib）、Zotero RDF（.rdf）、Zotero RDF＋PDF（.zip）。
閱讀頁「引用卡片」也可複製單篇的 APA／BibTeX。

- 書目資料先查 **Crossref**（有 DOI 時；沒有 DOI 會用標題嚴格比對），再查 **Europe PMC**，結果存在每篇的 `biblio.json`；
  都查不到才用 AI 從 PDF 擷取的資料，畫面會提醒核對。
- Zotero RDF 會把每篇的書庫分類變成 Zotero 的 collection。.zip 版解壓縮後在 Zotero「檔案 → 匯入…」選裡面的 .rdf，PDF 會一起匯入。

## 雲端同步（OneDrive／Google Drive）

設定 →「書庫位置」→「變更位置…」。做法參考 EasyRead：論文伴讀**不直接連雲端、不需登入**，
而是把書庫資料夾放進 OneDrive 或 Google Drive 電腦版正在同步的資料夾，由它們負責上傳與同步。

- 會自動偵測 OneDrive（環境變數 `OneDrive`）與 Google Drive 電腦版（`G:\我的雲端硬碟`、`~\My Drive`）；其他同步資料夾用「其他資料夾」選。
  選上層資料夾會自動建 `paper-reader` 子資料夾。
- 搬移是**複製**：逐篇複製、核對檔案大小後才改用新位置；原本的書庫原封不動保留。搬移中暫停所有寫入。
  目的地已有書庫時可「合併」（兩邊都有的論文保留較晚修改的那份）或「直接改用」。
- 放進 OneDrive 會設成「一律保留在此裝置」（`attrib +P`），離線也能開。
- 同步的是 `papers\` 與 `library.json`；`settings.json`（模型、PaperBrain 路徑）和 `location.json`（書庫在哪）留在本機 `data\`，每台電腦各自設定。
- 每台開著書庫的電腦每分鐘在 `.paper-reader-hosts\` 留心跳；另一台 3 分鐘內開過時，書庫頁會顯示警告。請一次只在一台電腦開。
- 開機時雲端資料夾不在（例如雲端硬碟還沒掛上）會暫用本機書庫並顯示警告，資料夾出現後自動切回。

## 模型與 effort

設定裡每個功能都可以分別選模型（Opus 5.5、Sonnet 5.5、Fable 5.2、Fable 5.1、Haiku 4.5）和 effort
（不思考、low、medium、high、xhigh、max），對話框也可以每次切換。2026-09-29 在這台電腦的實測：

| 動作 | 設定 | 開始出字 | 完成 |
|---|---|---|---|
| 對話 | Opus 5.5・low | 2.6 秒 | 7 秒 |
| 段落解釋 | Opus 5.5・low | 2.8 秒 | 17–22 秒 |
| 翻譯一頁（26 段） | Opus 5.5・不思考 | 11 秒 | 25 秒 |
| 翻譯一頁 | Sonnet 5.5・不思考 | 4 秒 | 25 秒 |

注意：Haiku 4.5 在 Claude Code 裡若沒設「不思考」會先長考，翻一頁曾花到 3 分鐘以上。

## 設定與資料

- 左下角「設定」可調整各功能使用的模型（預設：翻譯／摘要／解釋／對話用 Sonnet，快速翻譯與參考文獻擷取用 Haiku）與背景同時執行數。
- 資料夾：書庫預設在 `data\`（可在設定改到雲端同步資料夾，見上方），每篇在 `papers\<id>\`（`paper.pdf`、`layout.json`、`analysis.json`、`trans\`、`notes.md`、`highlights.json`、`explanations.json`、`chat.json`、`quiz.json`、`refs.json`、`images\`、`skillnotes.json`、`biblio.json`）；刪除的論文在 `trash\<id>\`。
  要換位置可設環境變數 `PAPER_READER_DATA`；換埠用 `PAPER_READER_PORT`。
- 掃描檔（沒有文字層）只能閱讀，翻譯與 AI 功能無法使用。
- 前端函式庫（PDF.js 4.10.38、marked、DOMPurify、KaTeX）從 cdnjs 載入，需要網路。
