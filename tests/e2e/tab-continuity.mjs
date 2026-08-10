// E2E (playwright-core + system Chrome): switching away from the gomoku tab
// must not interrupt the game. Boots an AI-vs-AI game, switches to the chat
// tab, waits, switches back, and asserts more stones were played while the
// view was unmounted. Requires a running `dsh web` instance (edit BASE).
// Usage: node tests/e2e/tab-continuity.mjs
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Resolve playwright-core from the harness monorepo's pnpm store.
const { chromium } = require('/Users/yejiming/.dsh/source/current/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.GOMOKU_E2E_BASE ?? 'http://127.0.0.1:3088'
const SESSION_TITLE = process.env.GOMOKU_E2E_SESSION ?? '安装dsh-gomoku插件到项目'
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => consoleErrors.push(String(err)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (label) => console.log(`\n== ${label}`)
const stoneCount = () => page.evaluate(() =>
  document.querySelectorAll('[role="grid"] button span[class*="stone"]').length)

step('load page')
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(4000)

step('open a session so the conversation tabs exist')
const opened = await page.evaluate((title) => {
  const el = [...document.querySelectorAll('*')].find(e => e.textContent?.trim() === title)
  if (!el) return false
  (el.closest('[role="button"],button,a') ?? el).click()
  return true
}, SESSION_TITLE)
if (!opened) throw new Error(`session "${SESSION_TITLE}" not found in the sidebar`)
await page.waitForTimeout(5000)

step('open the gomoku tab and start AI vs AI')
const started = await page.evaluate(() => {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent?.includes('五子棋'))
  if (!tab) return false
  tab.click()
  return true
})
if (!started) throw new Error('gomoku tab not found')
await page.waitForTimeout(1500)
const modeClicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('双 AI 对弈'))
  btn?.click()
  return btn !== undefined
})
if (!modeClicked) throw new Error('mode button not found')
await page.waitForTimeout(8000)
const before = await stoneCount()
console.log('stones before leaving:', before)

step('switch to the chat tab and wait 10s (game continues in background)')
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent?.trim() === '对话')
  tab?.click()
})
await sleep(10_000)

step('switch back to the gomoku tab')
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent?.includes('五子棋'))
  tab?.click()
})
await page.waitForTimeout(1500)
const after = await stoneCount()
console.log('stones after returning:', after)

const progressed = after > before
console.log(progressed ? 'PASS  game continued while the tab was away' : 'FAIL  game did not progress while away')
console.log('console errors:', consoleErrors.slice(0, 5))
await browser.close()
process.exit(progressed ? 0 : 1)
