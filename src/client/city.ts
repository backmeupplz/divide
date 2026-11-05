// The street behind the game: the dusk sky and far skyline behind the canvas, and the two sides of
// the street in front of it (shown only on the menu, so the planet rises between them).

import { SIDE_H, SIDE_W, occupationSide, resistanceSide, skyline } from '../shared/keyart'

const svg = (cls: string, w: number, h: number, body: string, aspect = 'xMidYMax slice') =>
  `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="${aspect}" aria-hidden="true">${body}</svg>`

export function drawCity() {
  const sky = document.getElementById('sky')
  const city = document.getElementById('city')
  if (sky) sky.innerHTML = svg('sky-art', 1600, 1000, skyline(1600, 1000, 640, 'cs'))
  if (city)
    city.innerHTML =
      svg('street-side left', SIDE_W, SIDE_H, resistanceSide('cl'), 'xMinYMax meet') + svg('street-side right', SIDE_W, SIDE_H, occupationSide('cr'), 'xMaxYMax meet')
}
