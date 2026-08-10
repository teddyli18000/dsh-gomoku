// E2E: switching SESSIONS must not interrupt the gomoku game. Start an
// AI-vs-AI game in session A, switch to session B in the sidebar, wait,
// switch back to A, and assert more stones were played while away.
import { createRequire } from 'node:module'

const require = createRequire('/Users/yejiming/.dsh/source/current/apps/cli/package.json')
const { chromium } = require('/Users/yejiming/.dsh/source/current/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = 'process.env.GOMOKU_E2E_BASE ?? "http://127.0.0.1:3089"'
const SESSION_A = '安装dsh-gomoku插件到项目'
const SESSION_B = '总结Harness项目特性并整理说明文件'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
const consoleErrors = []
page.on('pageerror', (err) => consoleErrors.push(String(err)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (label) => console.log(`\n== ${label}`)
const stoneCount = () => page.evaluate(() =>
  document.querySelectorAll('[role="grid"] button span[class*="stone"]').length)

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function clickSession(title) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll('*')].find(e => e.textContent?.trim() === t)
    if (!el) return false
    const clickable = el.closest('[role="button"],button,a') ?? el
    clickable.click()
    return true
  }, title)
}

step('load and open session A')
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(4000)
if (!(await clickSession(SESSION_A))) throw new Error('session A not found')
await waitFor(async () => (await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(t => t.textContent))).includes('五子棋'), 15000, 'gomoku tab in session A')

step('start AI vs AI on the gomoku tab')
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent?.includes('五子棋'))
  tab?.click()
})
await waitFor(async () => (await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent?.includes('双 AI 对弈')))), 10000, 'mode button')
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('双 AI 对弈'))
  btn?.click()
})
await waitFor(async () => (await stoneCount()) > 0, 20000, 'first AI stones')
await sleep(3000)
const before = await stoneCount()
console.log('stones before leaving session A:', before)

step('switch to session B (sidebar) and wait 12s')
if (!(await clickSession(SESSION_B))) throw new Error('session B not found')
await waitFor(async () => (await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].length)) > 0, 10000, 'conversation tabs in session B')
console.log('session B opened (tabs:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(t => t.textContent))), ')')
await sleep(12_000)

step('switch back to session A')
if (!(await clickSession(SESSION_A))) throw new Error('session A not found again')
await waitFor(async () => (await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(t => t.textContent))).includes('五子棋'), 15000, 'gomoku tab back in session A')
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent?.includes('五子棋'))
  tab?.click()
})
await sleep(1500)
const after = await stoneCount()
console.log('stones after returning to session A:', after)

const progressed = after > before
console.log(progressed ? 'PASS  game continued while on another session' : 'FAIL  game did not progress while on another session')
console.log('console errors:', consoleErrors.slice(0, 5))
await browser.close()
process.exit(progressed ? 0 : 1)
