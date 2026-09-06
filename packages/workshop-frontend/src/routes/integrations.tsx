import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Green Hat fork: the page is presented as "Integrations", but its canonical URL stays
 * /gatekeepers (the management-app host route /gatekeepers/$appId and every typed link depend on
 * it). This alias lets /integrations work, preserving search params and hash.
 */
export const Route = createFileRoute('/integrations')({
  beforeLoad: () => {
    throw redirect({ to: '/gatekeepers', search: true, hash: true, replace: true })
  },
  component: () => null,
})
