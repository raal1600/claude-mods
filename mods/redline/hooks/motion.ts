// The moving pieces: small SVGs the pane sets among its rows while a turn runs.
// Each is a few shapes in the app's own clay accent over a neutral grey that
// sits on a dark or a light ground. Nothing here moves while the session waits.

export const CLAY = '#D97757'
const GREY = '#808080'

const svg = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/** A ring with one arc going round: a turn is running. */
export const SPINNER = svg(
  16,
  16,
  `<circle cx="8" cy="8" r="6" fill="none" stroke="${GREY}" stroke-opacity="0.3" stroke-width="2"/>` +
    `<path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="${CLAY}" stroke-width="2" stroke-linecap="round">` +
    `<animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/></path>`,
)

/** Three dots lighting in turn: this call is still running. */
export const DOTS = svg(
  22,
  8,
  [0, 1, 2]
    .map(
      i =>
        `<circle cx="${4 + i * 7}" cy="4" r="2" fill="${CLAY}" opacity="0.25">` +
        `<animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="${(i * 0.2).toFixed(1)}s" repeatCount="indefinite"/></circle>`,
    )
    .join(''),
)

/** How tall a timeline row's mark is, in CSS pixels: it sets the row's height. */
export const RAIL_HEIGHT = 30
export const RAIL_WIDTH = 12

/**
 * One row's piece of the timeline's line: a filled dot for a milestone, a small
 * grey one for a lesser entry, and the line through it. Each piece is as tall
 * as its row, so stacked rows draw one unbroken line; the first row's starts
 * at its dot and the last row's ends there.
 */
export const railMark = (isMilestone: boolean, isFirst: boolean, isLast: boolean): string => {
  const x = RAIL_WIDTH / 2
  const mid = RAIL_HEIGHT / 2
  const from = isFirst ? mid : 0
  const to = isLast ? mid : RAIL_HEIGHT
  const line =
    from === to
      ? ''
      : `<line x1="${x}" y1="${from}" x2="${x}" y2="${to}" stroke="${GREY}" stroke-opacity="0.45" stroke-width="1.5"/>`
  const dot = isMilestone
    ? `<circle cx="${x}" cy="${mid}" r="4" fill="${CLAY}"/>`
    : `<circle cx="${x}" cy="${mid}" r="2.5" fill="${GREY}"/>`

  return svg(RAIL_WIDTH, RAIL_HEIGHT, line + dot)
}

/** A small ring: nothing is running. */
export const IDLE = svg(
  16,
  16,
  `<circle cx="8" cy="8" r="5" fill="none" stroke="${GREY}" stroke-opacity="0.7" stroke-width="1.5"/>`,
)

/**
 * The plan as a thin bar, one segment to a step: done ones filled, the one in
 * hand with a light running across it, the rest empty. With no plan, one
 * segment the light crosses: work with no stated end.
 */
export const progressBar = (width: number, steps: number, current: number): string => {
  const n = Math.max(1, steps)
  const gap = 3
  const h = 4
  const w = Math.max(4, (width - gap * (n - 1)) / n)
  let body = ''
  for (let i = 0; i < n; i += 1) {
    const x = i * (w + gap)
    const at = `x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${h}" rx="2"`
    if (steps > 0 && i < current) {
      body += `<rect ${at} fill="${CLAY}"/>`
    } else if (steps === 0 || i === current) {
      const run = Math.max(10, w * 0.45)
      body +=
        `<clipPath id="c"><rect ${at}/></clipPath>` +
        `<rect ${at} fill="${CLAY}" opacity="0.28"/>` +
        `<rect y="0" width="${run.toFixed(1)}" height="${h}" rx="2" fill="${CLAY}" clip-path="url(#c)">` +
        `<animate attributeName="x" values="${(x - run).toFixed(1)};${(x + w).toFixed(1)}" dur="1.4s" repeatCount="indefinite"/></rect>`
    } else {
      body += `<rect ${at} fill="${GREY}" opacity="0.25"/>`
    }
  }

  return svg(Math.round(width), h, body)
}
