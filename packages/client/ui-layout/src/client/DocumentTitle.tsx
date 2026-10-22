/** Browser title selection follows the active main panel without subscribing the frame. */
import { useEffect } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type SessionsSnapshot = Parameters<Parameters<PropsRuntime<'root'>['useSessions']>[0]>[0]

/**
 * Select the Session that currently holds the main view.
 * @param state - Sessions snapshot.
 * @returns The retained Session id, or `undefined` when no Session holds the main view.
 */
export function mainViewSessionId(state: SessionsSnapshot): SessionsSnapshot['ids'][number] | undefined {
  return Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** Props for the browser title projection. */
export type DocumentTitleProps = Pick<PropsRuntime<'root'>, 'useSessions' | 'usePanelInfo'> & {
  /** Build-configured or localized product title. */
  productTitle: string
}

/**
 * Project the selected durable session title into the browser title and
 * restore the build-selected product title when unmounted.
 * @param props - Selected session title projection.
 * @returns No rendered content.
 */
export function DocumentTitle({ useSessions, usePanelInfo, productTitle }: DocumentTitleProps): null {
  const showSessionTitle = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions((state) => {
    const current = mainViewSessionId(state)
    return !showSessionTitle || current === undefined ? undefined : state.byId[current]?.title
  })
  useEffect(() => {
    document.title = title === undefined ? productTitle : `${title} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}
