/**
 * Phone, tablet, and desktop shell geometry for `dsh web`.
 *
 * Below the 768px compact breakpoint the sidebar is an overlay drawer with no
 * grid track, a session pick closes it, the composer stays inside the viewport,
 * and Settings fills the screen. Tablet and desktop widths keep the docked
 * sidebar. No viewport scrolls horizontally.
 */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'

const MARKER = 'MOBILE_LAYOUT_DONE'

function fixture(): string {
  const session = Session.create(SessionId('mobile-layout-source'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Summarize the layout.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: ['| File | Lines | Status | Owner | Notes |', '| --- | --- | --- | --- | --- |', '| AppFrame.tsx | 307 | changed | ui-layout | drawer and scrim |', '', MARKER].join('\n') }],
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), '',
  ].join('\n')
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
}

async function frameState(page: Page): Promise<{ compact: boolean; drawerOpen: boolean; sidebarWidth: number; sidebarVisible: boolean }> {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('[data-shell-sidebar]')
    const frame = sidebar?.parentElement
    const rect = sidebar?.getBoundingClientRect()
    return {
      compact: frame?.hasAttribute('data-compact') ?? false,
      drawerOpen: frame?.hasAttribute('data-drawer-open') ?? false,
      sidebarWidth: Math.round(rect?.width ?? 0),
      sidebarVisible: sidebar !== null && getComputedStyle(sidebar).visibility !== 'hidden' && (rect?.right ?? 0) > 0,
    }
  })
}

function sidebarToggle(page: Page) {
  return page.locator('[data-shell-leading]').getByRole('button', { name: 'Open sidebar', exact: true })
}

describe('mobile web layout', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture(), 'mobile-layout')
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  async function open(width: number, height: number): Promise<Page> {
    const touch = width < 1024
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: touch, isMobile: touch })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-shell-sidebar]').waitFor({ state: 'attached' })
    return page
  }

  it('phone: the sidebar is a closed overlay drawer that a session pick dismisses', async () => {
    const page = await open(390, 844)
    try {
      expect(await frameState(page)).toMatchObject({ compact: true, drawerOpen: false, sidebarVisible: false })
      expect(await horizontalOverflow(page)).toBe(0)

      await sidebarToggle(page).click()
      await expect.poll(async () => (await frameState(page)).sidebarVisible).toBe(true)
      const opened = await frameState(page)
      expect(opened.drawerOpen).toBe(true)
      // min(85vw, 280px): the stored default width fits under the 85% cap.
      expect(opened.sidebarWidth).toBe(280)
      expect(await page.locator('[data-shell-drawer-scrim]').count()).toBe(1)

      const tree = page.locator('[role="treeitem"]')
      await tree.first().click()
      await tree.nth(1).click()
      await page.getByText(MARKER, { exact: true }).waitFor()
      await expect.poll(async () => (await frameState(page)).drawerOpen).toBe(false)
      expect(await page.locator('[data-shell-drawer-scrim]').count()).toBe(0)

      const composer = await page.locator('[contenteditable="true"]').first().boundingBox()
      expect(composer).not.toBeNull()
      expect(composer!.x).toBeGreaterThanOrEqual(0)
      expect(composer!.x + composer!.width).toBeLessThanOrEqual(390)
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(844)
      expect(await horizontalOverflow(page)).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('phone: Escape and the scrim close the drawer, and Settings fills the viewport', async () => {
    const page = await open(390, 844)
    try {
      const toggle = sidebarToggle(page)
      await toggle.click()
      await expect.poll(async () => (await frameState(page)).drawerOpen).toBe(true)
      await page.keyboard.press('Escape')
      await expect.poll(async () => (await frameState(page)).drawerOpen).toBe(false)

      await toggle.click()
      await expect.poll(async () => (await frameState(page)).drawerOpen).toBe(true)
      await page.locator('[data-shell-drawer-scrim]').click({ position: { x: 370, y: 400 } })
      await expect.poll(async () => (await frameState(page)).drawerOpen).toBe(false)

      await toggle.click()
      await page.locator('[data-shell-sidebar]').getByRole('button', { name: 'Account menu', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Settings/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      const box = await dialog.boundingBox()
      expect(box).toMatchObject({ x: 0, width: 390 })
      expect(await horizontalOverflow(page)).toBe(0)
    } finally {
      await page.close()
    }
  })

  for (const [width, height] of [[820, 1180], [1440, 900]] as const) {
    it(`${width}px keeps the docked sidebar without horizontal overflow`, async () => {
      const page = await open(width, height)
      try {
        const state = await frameState(page)
        expect(state.compact).toBe(false)
        expect(state.drawerOpen).toBe(false)
        expect(await page.locator('[data-shell-drawer-scrim]').count()).toBe(0)
        expect(await horizontalOverflow(page)).toBe(0)
      } finally {
        await page.close()
      }
    })
  }
})
