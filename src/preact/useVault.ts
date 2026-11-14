import { useLayoutEffect, useState } from 'preact/hooks'
import type { VaultController, VaultView } from '../controller.js'
export function useVault(controller: VaultController): VaultView {
  const [view, setView] = useState(() => controller.getView())
  useLayoutEffect(() => {
    const off = controller.subscribe(setView)
    setView(controller.getView())
    return off
  }, [controller])
  return view
}
