# mistvault

Browser-encrypted distributed vaults for TypeScript applications. Compatible with the `tc-escrow v1` protocol served by mistl. The portable core has no runtime dependencies; the settings panel optionally uses Preact 10.

[日本語](README.ja.md) · [中文](README.zh.md)

## Install

```sh
npm install github:tik-choco-lab/mistvault
```

Git dependencies compile through `prepare`. Generated `dist/` files are excluded from Git. For development, run `npm install`, `npm run build`, and `npm test`.

## Connect an application

```ts
import { createVault, createMistVaultTransport } from '@tik-choco/mistvault'
import type { VaultAdapter, MistNodeLike } from '@tik-choco/mistvault'

type Entry = { updatedAt: number; text: string }
type State = { entries: Record<string, Entry>; deleted: Record<string, number> }

function merge(local: State, remote: State): State {
  const entries = { ...remote.entries }
  const deleted = { ...remote.deleted }
  for (const [id, at] of Object.entries(local.deleted)) {
    deleted[id] = Math.max(deleted[id] ?? 0, at)
  }
  for (const [id, entry] of Object.entries(local.entries)) {
    const previous = entries[id]
    if (!previous || entry.updatedAt > previous.updatedAt ||
      entry.updatedAt === previous.updatedAt && entry.text > previous.text) entries[id] = entry
  }
  for (const [id, entry] of Object.entries(entries)) {
    if ((deleted[id] ?? -1) >= entry.updatedAt) delete entries[id]
  }
  return { entries, deleted }
}

export function connectVault(
  adapter: VaultAdapter<State>,
  createNode: () => MistNodeLike,
  storageAdd: (name: string, bytes: Uint8Array) => Promise<string>,
  storageGet: (cid: string) => Promise<Uint8Array>,
) {
  return createVault({ adapter: { ...adapter, merge }, transport: () =>
    createMistVaultTransport({ createNode, storageAdd, storageGet }) })
}
```

Implement `snapshot`, `parse`, `apply`, and `subscribe` against your application's stores. Use a stable `app` ID and a versioned `schema`. `parse` must validate untrusted remote JSON and throw on invalid input. `merge` must be deterministic, idempotent and preserve newer records from both sides, including deletion tombstones. `apply` persists the merged result and refreshes the application. Only notifications emitted synchronously by the call to `apply` are suppressed; edits during an asynchronous apply remain dirty. Before writing each record, `apply` must compare its current revision with the revision captured by `snapshot` and skip records that changed. Keep the check and write in one synchronous block or one IndexedDB readwrite transaction, and preserve local tombstones. The controller retries a merge if edits arrive before apply and checks the resulting snapshot afterwards. Keep tombstones long enough to cover offline devices; 90 days is a useful starting point.

Only include application data. Exclude API keys, service settings, access tokens, identity private keys, the vault code, and disposable caches. Arrays that represent sets should have a stable order to avoid unnecessary saves.

Pass a `createNode` factory that returns a fresh handle from your application's existing shared node scope on each call. The transport creates one handle per joined room, initializes it lazily, uses reliable delivery `0`, and releases it with `leaveRoom(room)`. Events without a room argument belong to that handle's room; explicitly tagged events from other rooms are ignored. Sharing the underlying scope with other network features is supported. `joinRoomAsync` is preferred when present; otherwise `joinRoom` is awaited. The default event numbers are raw `0`, connected `2`, disconnected `3`; override `events` for other bindings. The transport bounds control messages at 16 KiB and its pre-join queue at 64, and shares concurrent downloads for the same CID when handles use the same `storageGet` function.

## Preact settings

```tsx
import { VaultPanel } from '@tik-choco/mistvault/preact'
import type { VaultController } from '@tik-choco/mistvault'
import '@tik-choco/mistvault/ui.css'

export const Settings = ({ vault }: { vault: VaultController }) =>
  <VaultPanel controller={vault} locale="ja" appName="Notebook" />
```

`useVault(controller)` provides the current `VaultView` for a custom interface. `VaultPanel` includes setup actions, an app switch, status, save and restore actions, room configuration, masked code controls, confirmed imports, device links and attachment counts. The interface supports English, Japanese, Simplified Chinese and Traditional Chinese. An omitted locale uses `navigator.language`, with English as the fallback.

If the application consumes a device link before mounting the panel, pass its privately retained code as `pendingCode`. The panel asks for confirmation, then calls `onPendingHandled(result)` with `"imported"` or `"cancelled"`; clear `pendingCode` in that callback. Invalid supplied codes can be dismissed and report `"cancelled"`. A failed import remains available for retry. Importing a code while the vault is off turns it on in automatic mode after confirmation.

Set `--mv-fg`, `--mv-muted`, `--mv-border`, `--mv-accent`, and `--mv-bg` to match your application. Controls wrap at narrow widths and follow the system color scheme. Multiple panels can coexist without duplicate control IDs.

## Personal code and provider room

The default is **off**. Enabling generates a random 128-bit code and selects automatic mode. All applications on one origin share `tc-vault:settings-v1`; storage events update other tabs. Each application has separate encryption and signing keys and its own `tc-vault:app:<app>:v1` metadata. Importing another code resets every stored application's sequence, hashes and part inventory while retaining local application data and app preferences.

Automatic mode uses `deriveAutoRoom('tc-vault', code)` so one room serves all applications for a person. Add the displayed room in **mistl → Storage → Distributed vault**, or run:

```sh
mistl escrow rooms add <room>
```

Watermarks and attachment inventories belong to the combination of code and effective room. Changing either resets that metadata before restore; local application data remains available to merge.

Anyone holding the code can read and write the vault. Store it securely. Device links place it in the URL fragment, never in a query parameter. `VaultPanel` removes the fragment when mounted and asks for confirmation before importing. Applications that mount settings later should call `consumeVaultLink()` on load, retain its returned code privately, and pass it as `pendingCode` or offer their own confirmation before calling `importCode`; consuming a link does not import it.

Code helpers accept uppercase and grouped input, then return lowercase canonical base32. Invalid trailing bits are rejected. `vaultLink(url, code)` creates a device link; `revealCode()` returns the current secret only on demand.

## Controller behavior

`createVault({ adapter, transport, storage?, now?, partGcGraceMs? })` returns:

| Method | Purpose |
| --- | --- |
| `getView()`, `subscribe(cb)` | Observe mode, app preference, rooms, status, errors, timestamps, sequence and part counts. Subscription returns an unsubscribe function. |
| `enable()`, `disable()` | Set the shared personal vault to automatic mode or off. |
| `setAppEnabled(on)` | Change only this application's participation. |
| `configure(mode, room?)` | Select `auto`, `custom` or `off`; invalid rooms return `false`. |
| `importCode(code)`, `revealCode()` | Switch codes after caller confirmation, or read the current code. Invalid imports return `false`. |
| `saveNow()`, `restoreNow()` | Flush dirty data or explicitly restore and merge. Errors appear in the view. |
| `dispose()` | Stop networking, subscriptions, locks and timers. |

No node is created while inactive. Startup waits up to 20 seconds for a provider, then continues listening if none is available. Every session completes a restore attempt before uploading. Local changes persist a dirty flag and save after 8 seconds of quiet, with a 60-second maximum delay. Hidden-page and pagehide events attempt a flush. A save uses the preceding signed head's hash and next sequence; conflicts trigger restore, merge and retry, up to three attempts. Errors use a 60-second retry delay and may also be retried by another edit or manual action.

Join failures and provider loss trigger rejoining while visible, starting after five seconds and doubling up to sixty seconds. Returning online or making the page visible also retries discovery.

Where available, `navigator.locks` elects one writer per application. Followers publish edits through shared dirty metadata; the writer reads it before saving and on each visible poll. An ACK clears dirty only if the shared edit version and token still match the saved snapshot. Followers restore when the writer publishes local metadata and also check the remote head every 60 seconds while visible. A new lock holder restores before writing. Without that API, compare-and-swap and merge handle concurrent writes. Browser shutdown can interrupt best-effort flushing; local application persistence remains the adapter's responsibility.

Storage reads and writes tolerate unavailable or full localStorage. In that case the running controller retains its settings in memory, but cannot share or retain them across reloads.

## Attachments

Add `adapter.parts` with `list(state)`, `read(id)`, `has(id)`, `write(id, bytes)` and optional `maxBytes`. IDs must match `[A-Za-z0-9_.:-]{1,128}`; content-addressed IDs such as `f:` plus a SHA-256 hex digest are recommended. Report the actual uncompressed size in `list`.

Parts derive distinct slot, AES-GCM and Ed25519 keys from the application's cached PBKDF2 master, without extra PBKDF2 work. New or changed attachments upload before the main checkpoint. Missing attachments download after restore with concurrency limited to two. The default maximum is 32 MiB minus 64 KiB. Oversized, locally missing and provider-quota-limited attachments are listed as omitted; the main checkpoint still saves. Omission metadata is local to each app and device.

Save and restore check provider heads even when bytes are available locally. A missing or deleted part invalidates its uploaded cache entry and is uploaded again from local bytes. Saves also recheck parts after the main ACK. If a restore cannot obtain bytes, the part stays pending and retries on later restores and visible polls; no placeholder bytes are written.

A part becomes eligible for collection only after every acknowledged or observed current main state has left it unreferenced for at least 24 hours. The per-part `unreferencedSince` timestamp persists across reloads and resets whenever references return. Set `partGcGraceMs` to a nonnegative duration in milliseconds to configure this grace. Collection verifies the tracked part's exact generation and rechecks the current main head immediately before deletion. A changed main head defers collection. Grace and repair mitigate delayed deletion races; excluding them completely requires provider-side reference counting. The uploaded cache entry is removed before DELETE, and a separate pending deletion record supports retries even if the ACK is lost. Collection runs in the background and requires providers supporting the `delete` feature. Providers supporting `delete-continue` can recreate a deleted slot using its next sequence and deleted-head parent. Collection concerns this application's previously recorded part slots only.

## Portable API

The root entry exports the controller, adapter, settings, code, transport and attachment interfaces above, plus:

- `EscrowClient`, `EscrowRequestError`; client methods `join`, `onProvider`, `waitForProvider`, `getHead`, `put`, `fetchLatest`, `saveCheckpoint`, `deleteSlot`, `dispose`, and the `providers` getter. Part methods are `fetchLatestWithKeys`, `saveWithKeys`, and `deleteWithKeys`.
- Keys and blob utilities: `deriveEscrowKeys`, `derivePartKeys`, `deriveAutoRoom`, `blobAAD`, `encryptBlob`, `decryptBlob`, `gzip`, `gunzip`, `supportsGzip`, `sha256`, `hex`, `fromHex`, `utf8`, `base64url`, `fromBase64url`.
- Signed heads and protocol: `parseHead`, `buildHead`, `signHead`, `verifyHead`, `headHash`, `signingPayload`, `stableStringify`, `parseDelete`, `signDelete`, `deleteSigningPayload`, `parseEscrowMessage`, `encodeEscrowMessage`, `ERROR_CODES`, `MAX_MESSAGE_BYTES`, `DEFAULT_MAX_BLOB`, `DEFAULT_MAX_PLAINTEXT`, `MAX_CID_BYTES`, `MAX_SCHEMA_BYTES`, `SLOT_RE`, `HASH_RE`, `safeInt`, `boundedText`, `isRecord`.
- Codes and settings: `generateVaultCode`, `parseVaultCode`, `canonicalizeVaultCode`, `vaultLink`, `consumeVaultLink`, `VAULT_CODE_RE`, `loadSettings`, `saveSettings`, `loadAppState`, `saveAppState`, `subscribeSettings`, `defaultSettings`, `defaultAppState`, `browserStorage`, `SETTINGS_KEY`, `appStateKey`, `validVaultRoom`.
- Attachments: `PART_ID_RE`, `PART_SCHEMA`, `DEFAULT_MAX_PART_BYTES`, `DEFAULT_PART_GC_GRACE_MS`, `observePartReferences`, `listedParts`, `mapParts`, `uploadParts`, `fetchParts`, `collectParts`.
- Localization: `messages`, `en`, `ja`, `zhCN`, `zhTW`, `resolveLocale`, `vaultMessage`.

Associated TypeScript types include `VaultOptions`, `VaultAdapter`, `VaultController`, `VaultView`, `VaultParts`, `PartContext`, `VaultMode`, `VaultSettings`, `VaultAppState`, `PartState`, `MistNodeLike`, `MistVaultTransportOptions`, `VaultLocale`, `VaultMessages`, `EscrowKeys`, `UnsignedHead`, `EscrowHead`, `HeadValidation`, `DeleteFields`, `SignedDelete`, `EscrowTransport`, `Unsubscribe`, `ClientErrorCode`, `PutResult`, `DeleteResult`, `EscrowClientOptions`, `CheckpointOptions`, `ProtocolLimits`, and all `EscrowMessage` variants. The Preact entry exports `VaultPanel`, `VaultPanelProps`, and `useVault`.

`EscrowClient.join(true)` reacquires membership when no providers remain; ordinary `join()` keeps its existing behavior. `onProvider` also signals departures, so listeners should read `providers` to determine availability. Deletion returns the existing `error` result with code `transport` when evicted provenance prevents confirming every copy was removed. The wire protocol is unchanged. Optional app metadata fields `scope`, `editVersion`, `editToken`, `pendingDeletes`, `partsObservedSeq`, `PartState.headHash`, and `PartState.unreferencedSince` are managed by the controller and remain compatible with older stored state.

Web Crypto with Ed25519, AES-GCM, PBKDF2 and HKDF is required. Compression uses browser streams when available. Provider ACKs confirm persistence at the accepting provider; replication proceeds according to mistl's configuration. Keep independent backups for data you cannot replace.

## License

MPL-2.0. See [LICENSE](LICENSE).
