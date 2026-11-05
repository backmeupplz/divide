// Renders share images off the game thread: a resvg render of the street takes a few hundred ms,
// which would otherwise stall every match's 15 Hz tick.

import { render } from './og'

export type RenderJob = { id: number; svg: string; width?: number; opaque?: boolean }
export type RenderDone = { id: number; bytes?: Uint8Array; error?: string }

declare const self: Worker

self.onmessage = (e: MessageEvent<RenderJob>) => {
  const { id, svg, width, opaque } = e.data
  try {
    postMessage({ id, bytes: render(svg, width, opaque) } satisfies RenderDone)
  } catch (err) {
    postMessage({ id, error: String(err) } satisfies RenderDone)
  }
}
