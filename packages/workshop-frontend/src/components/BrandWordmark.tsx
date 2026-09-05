// The Greenhat OS wordmark, as shipped in `public/brand/` (Green Hat fork).
//
// Two renderings of the same artwork: white lettering for the dark theme and jet-black lettering
// for the light one, swapped by the `dark` variant so the mark never fights its surface. The
// green "OS" badge is identical in both. The image carries the site name as its alt text, so the
// brand row still reads as the deployment's name to assistive technology.
import { useSiteName } from '../ServerConfigContext'

export default function BrandWordmark({
  height,
  className,
}: {
  /** Rendered height in CSS pixels; the width follows the artwork's aspect ratio. */
  height: number
  className?: string
}) {
  const siteName = useSiteName()
  // Source PNGs are 64px tall, so anything up to 32px renders at 2x or better.
  const shared = {
    alt: siteName,
    height,
    draggable: false,
    className: `w-auto max-w-full object-contain ${className ?? ''}`,
  }
  return (
    <>
      <img
        {...shared}
        src="/brand/greenhatos-wordmark-on-light.png"
        className={`${shared.className} dark:hidden`}
      />
      <img
        {...shared}
        src="/brand/greenhatos-wordmark-on-dark.png"
        className={`${shared.className} hidden dark:block`}
      />
    </>
  )
}
