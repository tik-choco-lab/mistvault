export const en = {
  title: 'Distributed vault',
  explanation: 'Your data is encrypted in this browser and stored on your mistl node. mistl cannot read it. Keep your vault code secret: anyone with it can read and write your vault.',
  master: 'Enable personal vault', app: 'Back up {app} data', appFallback: 'this app',
  turnOn: 'Turn on the distributed vault', useCode: 'Use a code from another device',
  save: 'Save now', restore: 'Restore now', room: 'mistl room',
  hint: 'Add in mistl: Storage → Distributed vault', roomPending: 'Preparing room…', roomUnavailable: 'Available when backup is on', advanced: 'Advanced',
  mode: 'Mode', auto: 'Automatic', custom: 'Custom', off: 'Off', apply: 'Apply',
  code: 'Vault code', codeHint: 'Keep this code private. Anyone with it can read and write your vault.', reveal: 'Reveal', hide: 'Hide', copy: 'Copy', copied: 'Copied',
  link: 'Copy link for another device', import: 'Import code', importAnother: 'Import another code', importLabel: 'Code from another device',
  pendingTitle: 'Use a code from another device?',
  confirmation: 'Your local data stays on this device. If you already use a vault, this switches it to the new code.',
  confirm: 'Confirm import', cancel: 'Cancel', invalid: 'Invalid vault code or room.', copyError: 'Copy failed. Select and copy the value manually.',
  invalidCode: 'Invalid vault code.', importError: 'Could not import this vault code.',
  savedNow: 'Saved just now', savedAgo: 'Saved {minutes} min ago', savedHoursAgo: 'Saved {hours} hr ago', savedDayAgo: 'Saved 1 day ago', savedDaysAgo: 'Saved {days} days ago',
  parts: 'Attachments: {stored} stored, {pending} pending, {omitted} omitted',
  status_off: 'Vault is off', status_appOff: 'Backup is off for this app', status_searching: 'Searching for mistl…', status_noProvider: 'No provider found; still listening',
  status_restoring: 'Restoring…', status_saving: 'Saving…', status_saved: 'Saved', status_restored: 'Restored',
  status_upToDate: 'Up to date', status_error: 'Vault operation failed',
} as const
export type VaultMessages = Record<keyof typeof en, string>
export const ja: VaultMessages = {
  title: '分散保管庫',
  explanation: 'データはこのブラウザーで暗号化され、あなたの mistl ノードに保存されます。mistl は内容を読めません。保管庫コードを知る人は読み書きできるため、秘密にしてください。',
  master: '個人保管庫を有効にする', app: '{app} のデータをバックアップ', appFallback: 'このアプリ',
  turnOn: '分散保管庫を有効にする', useCode: '別の端末のコードを使う',
  save: '今すぐ保存', restore: '今すぐ復元', room: 'mistl ルーム',
  hint: 'mistl の「ストレージ → 分散保管庫」に追加', roomPending: 'ルームを準備中…', roomUnavailable: 'バックアップを有効にすると表示', advanced: '詳細設定',
  mode: 'モード', auto: '自動', custom: 'カスタム', off: '無効', apply: '適用',
  code: '保管庫コード', codeHint: 'このコードは秘密にしてください。知っている人は保管庫を読み書きできます。', reveal: '表示', hide: '隠す', copy: 'コピー', copied: 'コピーしました',
  link: '別の端末用リンクをコピー', import: 'コードを読み込む', importAnother: '別のコードを読み込む', importLabel: '別の端末のコード',
  pendingTitle: '別の端末のコードを使いますか？',
  confirmation: 'ローカルデータはこの端末に残ります。すでに保管庫を使用している場合は、新しいコードに切り替わります。',
  confirm: '読み込みを確認', cancel: 'キャンセル', invalid: '保管庫コードまたはルームが無効です。', copyError: 'コピーできませんでした。値を選択して手動でコピーしてください。',
  invalidCode: '保管庫コードが無効です。', importError: '保管庫コードを読み込めませんでした。',
  savedNow: 'たった今保存', savedAgo: '{minutes} 分前に保存', savedHoursAgo: '{hours} 時間前に保存', savedDayAgo: '1 日前に保存', savedDaysAgo: '{days} 日前に保存',
  parts: '添付ファイル：保存済み {stored}、待機中 {pending}、省略 {omitted}',
  status_off: '保管庫は無効です', status_appOff: 'このアプリのバックアップは無効です', status_searching: 'mistl を検索中…', status_noProvider: 'プロバイダーが見つかりません。引き続き待機中',
  status_restoring: '復元中…', status_saving: '保存中…', status_saved: '保存しました', status_restored: '復元しました',
  status_upToDate: '最新です', status_error: '保管庫の操作に失敗しました',
}
export const zhCN: VaultMessages = {
  title: '分布式保管库',
  explanation: '数据在此浏览器中加密，并存储在您的 mistl 节点上。mistl 无法读取内容。持有保管库代码的人可以读写数据，请妥善保密。',
  master: '启用个人保管库', app: '备份{app}的数据', appFallback: '此应用',
  turnOn: '启用分布式保管库', useCode: '使用其他设备的代码',
  save: '立即保存', restore: '立即恢复', room: 'mistl 房间',
  hint: '在 mistl 的“存储 → 分布式保管库”中添加', roomPending: '正在准备房间…', roomUnavailable: '启用备份后显示', advanced: '高级设置',
  mode: '模式', auto: '自动', custom: '自定义', off: '关闭', apply: '应用',
  code: '保管库代码', codeHint: '请妥善保密此代码。持有者可以读写您的保管库。', reveal: '显示', hide: '隐藏', copy: '复制', copied: '已复制',
  link: '复制其他设备的链接', import: '导入代码', importAnother: '导入其他代码', importLabel: '其他设备的代码',
  pendingTitle: '使用其他设备的代码？',
  confirmation: '本地数据会保留在此设备上。如果您已使用保管库，此操作会切换到新代码。',
  confirm: '确认导入', cancel: '取消', invalid: '保管库代码或房间无效。', copyError: '复制失败。请选中该值并手动复制。',
  invalidCode: '保管库代码无效。', importError: '无法导入此保管库代码。',
  savedNow: '刚刚保存', savedAgo: '{minutes} 分钟前保存', savedHoursAgo: '{hours} 小时前保存', savedDayAgo: '1 天前保存', savedDaysAgo: '{days} 天前保存',
  parts: '附件：已存储 {stored}，待处理 {pending}，已省略 {omitted}',
  status_off: '保管库已关闭', status_appOff: '此应用的备份已关闭', status_searching: '正在查找 mistl…', status_noProvider: '未找到提供者，继续等待',
  status_restoring: '正在恢复…', status_saving: '正在保存…', status_saved: '已保存', status_restored: '已恢复',
  status_upToDate: '已是最新', status_error: '保管库操作失败',
}
export const zhTW: VaultMessages = {
  title: '分散式保管庫',
  explanation: '資料在此瀏覽器中加密，並儲存在您的 mistl 節點上。mistl 無法讀取內容。持有保管庫代碼的人可以讀寫資料，請妥善保密。',
  master: '啟用個人保管庫', app: '備份{app}的資料', appFallback: '此應用程式',
  turnOn: '啟用分散式保管庫', useCode: '使用其他裝置的代碼',
  save: '立即儲存', restore: '立即還原', room: 'mistl 房間',
  hint: '在 mistl 的「儲存空間 → 分散式保管庫」中新增', roomPending: '正在準備房間…', roomUnavailable: '啟用備份後顯示', advanced: '進階設定',
  mode: '模式', auto: '自動', custom: '自訂', off: '關閉', apply: '套用',
  code: '保管庫代碼', codeHint: '請妥善保密此代碼。持有者可以讀寫您的保管庫。', reveal: '顯示', hide: '隱藏', copy: '複製', copied: '已複製',
  link: '複製其他裝置的連結', import: '匯入代碼', importAnother: '匯入其他代碼', importLabel: '其他裝置的代碼',
  pendingTitle: '使用其他裝置的代碼？',
  confirmation: '本機資料會保留在此裝置上。如果您已使用保管庫，此操作會切換到新代碼。',
  confirm: '確認匯入', cancel: '取消', invalid: '保管庫代碼或房間無效。', copyError: '複製失敗。請選取該值並手動複製。',
  invalidCode: '保管庫代碼無效。', importError: '無法匯入此保管庫代碼。',
  savedNow: '剛剛儲存', savedAgo: '{minutes} 分鐘前儲存', savedHoursAgo: '{hours} 小時前儲存', savedDayAgo: '1 天前儲存', savedDaysAgo: '{days} 天前儲存',
  parts: '附件：已儲存 {stored}，待處理 {pending}，已省略 {omitted}',
  status_off: '保管庫已關閉', status_appOff: '此應用程式的備份已關閉', status_searching: '正在尋找 mistl…', status_noProvider: '未找到提供者，繼續等待',
  status_restoring: '正在還原…', status_saving: '正在儲存…', status_saved: '已儲存', status_restored: '已還原',
  status_upToDate: '已是最新', status_error: '保管庫操作失敗',
}
export const messages = { en, ja, 'zh-CN': zhCN, 'zh-TW': zhTW }
export type VaultLocale = keyof typeof messages
export function resolveLocale(locale = globalThis.navigator?.language ?? 'en'): VaultLocale {
  const language = locale.toLowerCase()
  if (language.startsWith('ja')) return 'ja'
  if (language.startsWith('zh')) return /(?:tw|hk|mo|hant)/.test(language) ? 'zh-TW' : 'zh-CN'
  return 'en'
}
export function vaultMessage(locale: string | undefined, key: keyof VaultMessages, values: Record<string, string | number> = {}): string {
  return messages[resolveLocale(locale)][key].replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match))
}
