# mistvault

面向 TypeScript 应用的分布式保管库。数据在浏览器中加密，通过 mistl 的 `tc-escrow v1` 协议保存。核心没有运行时依赖；可选的设置面板使用 Preact 10。

[English / 完整 API](README.md) · [日本語](README.ja.md)

## 安装

```sh
npm install github:tik-choco-lab/mistvault
```

Git 依赖通过 `prepare` 自动构建，`dist/` 不纳入版本控制。开发时运行 `npm install`、`npm run build` 和 `npm test`。

```ts
import { createVault, createMistVaultTransport } from '@tik-choco/mistvault'

const vault = createVault({
  adapter,
  transport: () => createMistVaultTransport({ createNode, storageAdd, storageGet }),
})
```

为 `adapter` 设置稳定的 `app` 标识和带版本的 `schema`，并实现 `snapshot`、`parse`、`merge`、`apply`、`subscribe`。`parse` 必须验证远程 JSON，无效时抛出异常。`merge` 必须具有确定性和幂等性，保留双方较新的记录与删除标记；时间相同时也应使用固定的决胜规则。删除标记应保留足够长的离线同步时间，例如 90 天。`apply` 保存合并结果并刷新界面，仅抑制调用同步触发的通知，异步应用期间的编辑仍记为待保存。逐条写入前，应比较当前版本与快照捕获的版本，跳过已变化的记录；比较和写入须在同一同步代码段或 IndexedDB readwrite 事务内完成，并保留本地删除标记。控制器也会在应用前检测编辑并重新合并，完成后再次检查本地状态。

快照仅包含应用数据。不要包含 API 密钥、服务设置、令牌、身份私钥、保管库代码或可重新生成的缓存。

`createNode` 每次调用应从应用现有的共享节点作用域返回一个新句柄。传输层为每个房间创建一个句柄，以 `leaveRoom(room)` 释放。不带房间参数的事件归属该句柄的房间，明确标记为其他房间的事件会被忽略。节点按需初始化。传入现有的 `storageAdd` 和 `storageGet` 函数即可。可靠传输编号为 `0`，控制消息最大 16 KiB，加入房间前的队列最多 64 条。默认事件编号为 `raw: 0`、`peerConnected: 2`、`peerDisconnected: 3`，可通过 `events` 调整。使用相同 `storageGet` 函数的句柄会共享同一 CID 的并发下载。

## 设置面板

```tsx
import { VaultPanel } from '@tik-choco/mistvault/preact'
import '@tik-choco/mistvault/ui.css'

<VaultPanel controller={vault} locale="zh-CN" appName="笔记本" />
```

面板包含启用与导入操作、应用开关、状态、保存与恢复按钮、房间配置、隐藏的代码、复制、其他设备链接、确认导入及附件统计。自定义界面可使用 `useVault(vault)`。支持英语、日语、简体中文和繁体中文；繁体中文使用 `locale="zh-TW"`，省略时使用浏览器语言，未知语言回退到英语。

如果应用在面板挂载前读取了设备链接，可将私下保存的代码传给 `pendingCode`。确认导入或取消后，`onPendingHandled(result)` 会收到 `"imported"` 或 `"cancelled"`；请在回调中清除 `pendingCode`。关闭无效代码提示也会返回 `"cancelled"`。保管库关闭时确认导入，会以自动模式启用保管库。

通过 `--mv-fg`、`--mv-muted`、`--mv-border`、`--mv-accent` 和 `--mv-bg` 调整颜色。布局会在窄屏换行，并遵循系统的明暗主题。

## 个人代码与房间

默认关闭。启用时生成随机的 128 位保管库代码并切换到自动模式。同一来源的应用共享 `tc-vault:settings-v1`，通过存储事件跟随其他标签页的修改。每个应用的元数据保存在 `tc-vault:app:<app>:v1`。导入其他代码会重置所有已存应用的序列、哈希和附件记录，但保留本地应用数据及各应用开关。

自动房间由 `deriveAutoRoom('tc-vault', code)` 计算，所有应用共用一个个人房间。将显示的房间添加到 mistl 的“存储 → 分布式保管库”，或运行：

```sh
mistl escrow rooms add <room>
```

持有代码的人可以读写整个保管库，请妥善保密。设备链接将代码放在 URL 片段中。面板挂载时移除该片段，只有明确确认后才导入。如果应用稍后才显示设置面板，应在启动时调用 `consumeVaultLink()`，私下保留返回的代码，然后传给 `pendingCode`，或在用户确认后调用 `importCode`。读取并移除链接本身不会导入代码。

## 控制器

序列与附件缓存属于代码和实际房间的组合，任一变化都会重置。加入失败或提供者离开后，可见页面会从 5 秒开始重试加入，等待时间逐次翻倍，最多 60 秒；online 事件也触发重试。跟随标签页将编辑写入共享的待保存标志与编辑版本，写入标签页在保存前及轮询时读取，只有快照之后没有新编辑才清除标志。

- `getView()` / `subscribe(cb)`：读取或订阅模式、房间、状态、错误、时间、序列和附件统计。
- `enable()` / `disable()`：将共享保管库设为自动模式或关闭。
- `setAppEnabled(on)`：仅切换当前应用。
- `configure(mode, room?)`：配置 `auto` / `custom` / `off`；房间无效时返回 `false`。
- `importCode(code)` / `revealCode()`：导入已确认的代码或读取当前代码；无效导入返回 `false`。
- `saveNow()` / `restoreNow()`：保存待同步数据，或恢复并合并远程数据。
- `dispose()`：清理计时器、订阅、锁和网络连接。

未启用时不创建节点。启动后最多等待提供者 20 秒，超时后继续监听。首次成功尝试恢复前不会上传。变更后静默 8 秒保存，连续变更最多延迟 60 秒。页面隐藏或离开时尽力刷新。冲突会触发获取、合并和重试，最多尝试 3 次；错误显示在状态中，并在 60 秒后、下一次变更或手动操作时重试。

可用时通过 `navigator.locks` 为每个应用保留一个写入标签页。其他标签页收到本地保存通知后恢复，并在可见时每 60 秒检查远程头。锁交接后也先恢复再写入。不支持锁时通过协议的比较交换和合并处理并发。浏览器关闭可能中断刷新，因此应用仍需自行持久化本地数据。localStorage 不可用或已满时，当前控制器仍保留内存设置，但无法跨刷新保留或跨标签页共享。

## 附件

在 `adapter.parts` 中提供 `list(state)`、`read(id)`、`has(id)`、`write(id, bytes)`，以及可选的 `maxBytes`。ID 必须符合 `[A-Za-z0-9_.:-]{1,128}`，大小是未压缩的实际字节数。建议使用 `f:` 加内容 SHA-256 的标识。

附件复用应用已缓存的 PBKDF2 主密钥，通过 HKDF 派生独立槽位、加密和签名密钥，不会为每个附件重复执行 PBKDF2。新增或变化的附件先上传，然后保存主快照。恢复后以最多两个并发下载缺少的附件。默认上限为 32 MiB − 64 KiB。过大的、本地缺少的或因提供者配额受限的附件记为省略，主快照仍会保存。省略记录属于当前设备的应用元数据。

保存和恢复时，即使本地已有附件也会检查提供者头；若附件缺失或已删除，会使上传缓存失效并使用本地字节重新上传。主快照确认后也会再次检查。无法获取的附件保持待处理，在后续恢复和页面可见时的定期检查中重试，不写入占位字节。

只有在所有已确认或已观察到的当前主快照中持续至少24小时未被引用的附件，才会成为删除候选。每个附件的 `unreferencedSince` 会持久保存，引用重新出现时重置。可通过 `partGcGraceMs` 指定非负的毫秒数来调整宽限期。宽限期和修复可缓解延迟删除的竞态，完全排除竞态需要提供者端的引用计数。删除前验证附件的确切版本，并再次确认主快照的头未改变；若已改变则推迟删除。发送删除前先清除上传缓存，将重试信息另存，因此确认丢失后仍能重新引入附件。此操作需要提供者支持 `delete`。支持 `delete-continue` 的提供者允许以删除头的下一序列重新创建槽位。

## 核心与许可

`EscrowClient.join(true)` 在没有提供者时重新取得房间成员资格。`onProvider` 也通知离开事件，监听者应读取 `providers` 判断当前状态。头的来源记录被淘汰后，无法保证所有副本均已删除，删除操作返回现有的 `error` 结果及 `transport` 代码。通信格式与适配器必需 API 保持兼容。

还公开 `EscrowClient`、`deriveEscrowKeys`、`derivePartKeys`、`deriveAutoRoom`、签名与验证、协议解析及各项限制。附件密钥可通过 `fetchLatestWithKeys`、`saveWithKeys`、`deleteWithKeys` 使用。完整符号与类型列表见 [英文 README](README.md#portable-api)。

需要 Web Crypto 支持 Ed25519、AES-GCM、PBKDF2 和 HKDF。可用时使用浏览器压缩流。确认表示接收提供者已经持久保存，副本同步遵循 mistl 的配置。不可替代的数据仍应保留独立备份。

MPL-2.0，详见 [LICENSE](LICENSE)。
