import { launch, LaunchOptions, Browser, Page } from 'puppeteer-core'
import { Context } from 'koishi-core'
import { Logger, noop } from 'koishi-utils'
import { escape } from 'querystring'
export * from './svg'

declare module 'koishi-core/dist/app' {
  interface App {
    _browser: Promise<Browser>
    _idlePages: Page[]
  }
}

declare module 'koishi-core/dist/context' {
  interface Context {
    getPage (): Promise<Page>
    freePage (page: Page): void
  }
}

const logger = Logger.create('puppeteer')

Context.prototype.getPage = async function getPage (this: Context) {
  if (this.app._idlePages.length) {
    return this.app._idlePages.pop()
  }

  const browser = await this.app._browser
  logger.debug('create new page')
  return browser.newPage()
}

Context.prototype.freePage = function freePage (this: Context, page: Page) {
  this.app._idlePages.push(page)
}

export interface Options extends LaunchOptions {
  screenshot?: false
  latex?: false
}

export const name = 'puppeteer'

export function apply (ctx: Context, config: Options = {}) {
  const logger = ctx.logger('puppeteer')
  ctx.app._idlePages = []

  ctx.on('before-connect', () => {
    (ctx.app._browser = launch(config)).then(
      () => logger.debug('browser launched'),
      (error) => logger.warn(error),
    )
  })

  ctx.on('before-disconnect', async () => {
    const browser = await ctx.app._browser.catch<null>(noop)
    if (browser) await browser.close()
  })

  ctx.command('screenshot <url>', '网页截图', { authority: 2 })
    .alias('shot')
    .option('-f, --full-page', '对整个可滚动区域截图')
    .action(async ({ meta, options }, url) => {
      let page: Page
      try {
        page = await ctx.getPage()
      } catch (error) {
        return meta.$send('无法启动浏览器。')
      }

      try {
        await page.goto(url)
        logger.debug(`navigated to ${url}`)
      } catch (error) {
        ctx.freePage(page)
        return meta.$send('无法打开页面。')
      }

      const data = await page.screenshot({
        encoding: 'base64',
        fullPage: options.fullPage,
      })
      ctx.freePage(page)
      return meta.$send(`[CQ:image,file=base64://${data}]`)
    })

  ctx.command('latex <code...>', 'LaTeX 渲染', { authority: 2 })
    .option('-s, --scale <scale>', '缩放比例', { default: 2 })
    .usage('渲染器由 https://www.zhihu.com/equation 提供。')
    .action(async ({ meta, options }, tex) => {
      if (!tex) return meta.$send('请输入要渲染的 LaTeX 代码。')
      const page = await ctx.getPage()
      const viewport = page.viewport()
      await page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: options.scale,
      })
      await page.goto('https://www.zhihu.com/equation?tex=' + escape(tex))
      const svg = await page.$('svg')
      const inner = await svg.evaluate(node => node.innerHTML)
      const text = inner.match(/>([^<]+)<\/text>/)
      if (text) {
        await meta.$send(text[1])
      } else {
        const base64 = await page.screenshot({
          encoding: 'base64',
          clip: await svg.boundingBox(),
        })
        await meta.$send(`[CQ:image,file=base64://${base64}]`)
      }
      await page.setViewport(viewport)
      ctx.freePage(page)
    })
}
