# 論文伴讀 Chrome 擴充功能

在 Chrome 開啟 PDF 時，頁面左下角會顯示小型「用論文伴讀開啟」提示列。點選後，PDF 會加入本機書庫並開啟閱讀器；原本的 PDF 分頁會保留。這是本機擴充功能，尚未上架 Chrome 線上應用程式商店。

## 安裝一次

1. 使用 Chrome 127 或更新版本。
2. 開啟 `chrome://extensions/`，開啟右上角「開發人員模式」。
3. 點「載入未封裝項目」，選取這個 `chrome-extension` 資料夾（裡面有 `manifest.json`）。
4. 在 Chrome 右上角拼圖選單，將「論文伴讀：用閱讀器開啟 PDF」固定到工具列。
5. Windows：在完整程式資料夾雙擊 `install-browser-launcher.cmd`，貼上這個擴充功能的識別碼（卡片或連線設定可查看），完成一次性自動啟動安裝。若只下載擴充功能 ZIP，請先取得完整論文伴讀程式。未安裝啟動元件時，仍可手動啟動閱讀器。
6. 開啟或重新整理 PDF 分頁，左下角會出現提示列。若特定 PDF 檢視器不允許顯示提示，仍可點工具列的擴充功能圖示。

更新已載入的版本：在擴充功能卡片按「重新載入」（圓形箭頭）。已開啟的 PDF 分頁不必重新整理（限時簽章連結重新整理可能已失效）：切換到該分頁時，舊的提示列會自動換成新的。本版為 1.3.0，新增 `nativeMessaging` 權限；Chrome 若要求確認新增權限，請確認後重新啟用。

可使用這個範例測試：
https://pmc.ncbi.nlm.nih.gov/articles/PMC9760043/pdf/ijgm-15-8577.pdf

## 使用

- 網站回傳 `application/pdf` 時可辨識，即使網址沒有 `.pdf`。一般 `.pdf` 網址與本機 PDF 也有備援辨識。
- 重新載入擴充功能後，會檢查已開啟頁面的 PDF 類型，補回 Gmail 附件等沒有副檔名的 PDF；這項檢查不會重新下載附件。已確認是 HTML 的登入頁不會被當成 PDF。
- 只有目前使用中的 PDF 分頁會自動提示；同一分頁同一網址不重複提示。
- 提示載入失敗時，切換到其他分頁再切回來會重試；只有成功顯示才會記錄為已提示。仍未出現時，可從工具列圖示直接開啟，並確認擴充功能有目前網站的存取權。
- 按提示列的「×」只關閉此頁提示；按「⋯」可開啟設定，取消勾選「開啟 PDF 時顯示提示」後仍可從工具列手動開啟。
- 點選開啟後，新的分頁會顯示下載與匯入進度。相同 PDF 使用閱讀器既有的去重機制，不會重複建立文獻。
- 匯入時優先從原本的 PDF 分頁取回檔案（沿用該分頁已下載的內容與網站登入狀態），不再另外下載；ScienceDirect 等出版社的限時簽章連結因此也能匯入。原分頁已關閉或無法讀取時，才改由擴充功能重新下載。
- 閱讀器尚未啟動：點選開啟後，會顯示「正在背景啟動論文伴讀」，待閱讀器就緒再繼續匯入。已在執行時直接沿用；同時點選多篇 PDF 也不會重複啟動。不會因為只是瀏覽 PDF 就啟動程式。
- 可在「連線設定」按「測試自動啟動」。若提示找不到啟動元件，請完成上方的一次性安裝；移動程式資料夾、更換 Python 或重新載入後識別碼改變時，也需重新執行安裝。
- 本機 `file:///` PDF：在擴充功能的「詳細資料」開啟「允許存取檔案網址」；也可以在匯入頁手動選擇檔案。
- 若網站要求登入、網站驗證，或禁止擴充功能重新下載，請在原網站完成必要步驟並下載 PDF，再於匯入頁「選擇 PDF」。不會繞過存取限制。
- 單檔匯入上限 100 MB。`blob:` PDF、網頁內嵌 PDF 與強制下載回應不會自動提示，可下載後自行上傳。
- 預設連到 `http://127.0.0.1:8791`。不同連接埠可在擴充功能設定修改；只接受這台電腦的 IPv4 loopback。

## 權限與資料

- `webRequest`、HTTP/HTTPS 網站權限：辨識 PDF 回應類型，並在你點選開啟後重新取得那份 PDF。
- `tabs`：確認目前 PDF 分頁，開啟匯入頁。
- `scripting`：讀取已開啟頁面的網址與文件類型，補回擴充功能載入前開啟的 PDF；只在已辨識的 PDF 外層頁面加入左下角提示，以及在你點選開啟後從該分頁取回同一份 PDF；不修改 Chrome 內建 PDF 檢視器或 PDF 內容。
- `storage`：儲存提示偏好與連接埠；PDF 候選網址僅放在瀏覽器工作階段記憶體，關閉分頁後清除。
- `file:///*`：支援使用者另行允許的本機 PDF。
- `nativeMessaging`：透過 [Chrome 官方本機訊息機制](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)，要求本機啟動元件開啟閱讀器。元件只接受固定的啟動動作及連接埠，不接收 PDF 網址、檔案路徑或任意指令；安裝時只允許指定的擴充功能識別碼。
- 提示程式在擴充功能的隔離環境執行，不讀取其他擴充功能、不提供網頁可呼叫的匯入介面。PDF 只傳送至本機閱讀器，不另傳外部服務。閱讀器原有的自動摘要／翻譯設定仍會執行，AI 功能使用朋友自己的 Claude 登入。

## 開發驗證

在專案根目錄執行 `node tests/chrome-extension.test.mjs`、`node tests/browser-launcher.test.mjs`、`python tests/test_browser_launcher.py`。啟動測試使用獨立書庫與連接埠，確認真正的背景啟動、同時點選只啟動一次、啟動元件退出後閱讀器繼續執行。手動測試：PMC 範例、ScienceDirect 限時簽章 PDF、Gmail 附件、登入頁、閱讀器關閉時自動啟動、重複匯入、本機 PDF，以及關閉自動提示。

啟動元件登記在目前使用者的 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.paper_reader.launcher`，不需管理員權限。機器專用的路徑設定與日誌存於程式資料夾 `.browser-launcher`，不包含在分享 ZIP 或 Git 內。解除安裝可執行 `python native-host/install.py --uninstall`；書庫與桌面捷徑保留。

Chrome 官方文件：[隔離環境與頁面提示](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[跨來源請求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[載入未封裝擴充功能](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)。
