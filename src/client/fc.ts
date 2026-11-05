// Farcaster mini app glue. Outside a Farcaster client every call falls back to the plain web.
import { sdk } from '@farcaster/miniapp-sdk'

export type FcUser = { fid: number; username?: string; pfpUrl?: string }

export const fc = {
  inMiniApp: false,
  user: null as FcUser | null,
  haptics: false,
}

export async function initFarcaster() {
  try {
    fc.inMiniApp = await Promise.race([sdk.isInMiniApp(), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))])
    if (!fc.inMiniApp) return
    const ctx = await sdk.context
    fc.user = ctx.user ? { fid: ctx.user.fid, username: ctx.user.username, pfpUrl: ctx.user.pfpUrl } : null
    fc.haptics = !!ctx.features?.haptics
    const inset = ctx.client.safeAreaInsets
    if (inset) {
      const s = document.documentElement.style
      s.setProperty('--safe-top', `${inset.top}px`)
      s.setProperty('--safe-bottom', `${inset.bottom}px`)
      s.setProperty('--safe-left', `${inset.left}px`)
      s.setProperty('--safe-right', `${inset.right}px`)
    }
  } catch {
    fc.inMiniApp = false
  }
}

/** hides the splash screen; native swipe gestures are off so dragging steers instead of closing the app */
export function ready() {
  if (fc.inMiniApp) sdk.actions.ready({ disableNativeGestures: true }).catch(() => {})
}

/** a Quick Auth token proving the player's FID, or null for guests */
export async function authToken() {
  if (!fc.inMiniApp) return null
  try {
    return (await sdk.quickAuth.getToken()).token
  } catch {
    return null
  }
}

export async function cast(text: string, embed: string) {
  if (fc.inMiniApp) {
    try {
      await sdk.actions.composeCast({ text, embeds: [embed] })
      return
    } catch {
      // fall through to the web composer
    }
  }
  const url = `https://farcaster.xyz/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(embed)}`
  window.open(url, '_blank', 'noopener')
}

export function buzz(kind: 'light' | 'heavy' | 'success' | 'error') {
  if (!fc.haptics) return
  const h = sdk.haptics
  const p = kind === 'success' || kind === 'error' ? h.notificationOccurred(kind) : h.impactOccurred(kind === 'light' ? 'light' : 'heavy')
  p.catch(() => {})
}
