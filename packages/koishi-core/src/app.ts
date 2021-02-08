import { simplify, defineProperty, Time, Observed, coerce, escapeRegExp, makeArray, noop, template, merge } from 'koishi-utils'
import { Context, Middleware, NextFunction } from './context'
import { Argv } from './parser'
import { BotOptions, Server, createBots } from './server'
import { Channel, User } from './database'
import { Command } from './command'
import { Session } from './session'
import help, { getCommands } from './plugins/help'
import validate from './plugins/validate'
import LruCache from 'lru-cache'
import { AxiosRequestConfig } from 'axios'
import * as http from 'http'
import type Koa from 'koa'

export interface DelayOptions {
  character?: number
  message?: number
  cancel?: number
  broadcast?: number
  prompt?: number
}

export interface AppOptions extends BotOptions {
  port?: number
  bots?: BotOptions[]
  prefix?: string | string[]
  nickname?: string | string[]
  maxListeners?: number
  prettyErrors?: boolean
  processMessage?: (message: string) => string
  delay?: DelayOptions
  autoAssign?: boolean | ((session: Session) => boolean)
  autoAuthorize?: number | ((session: Session) => number)
  similarityCoefficient?: number
  userCacheLength?: number
  groupCacheLength?: number
  userCacheAge?: number
  groupCacheAge?: number
  axiosConfig?: AxiosRequestConfig
}

function createLeadingRE(patterns: string[], prefix = '', suffix = '') {
  return patterns.length ? new RegExp(`^${prefix}(${patterns.map(escapeRegExp).join('|')})${suffix}`) : /$^/
}

export enum AppStatus { closed, opening, open, closing }

export class App extends Context {
  public app = this
  public options: AppOptions
  public status = AppStatus.closed
  public bots = createBots('sid')

  _commands: Command[]
  _commandMap: Record<string, Command>
  _shortcuts: Command.Shortcut[]
  _hooks: Record<keyof any, [Context, (...args: any[]) => any][]>
  _userCache: Record<string, LruCache<string, Observed<Partial<User>, Promise<void>>>>
  _groupCache: LruCache<string, Observed<Partial<Channel>, Promise<void>>>
  _httpServer?: http.Server
  _sessions: Record<string, Session>

  private _nameRE: RegExp
  private _prefixRE: RegExp

  static defaultConfig: AppOptions = {
    maxListeners: 64,
    prettyErrors: true,
    userCacheAge: Time.minute,
    groupCacheAge: 5 * Time.minute,
    autoAssign: false,
    autoAuthorize: 0,
    similarityCoefficient: 0.4,
    processMessage: message => simplify(message.trim()),
    delay: {
      character: 0,
      cancel: 0,
      message: 0.1 * Time.second,
      broadcast: 0.5 * Time.second,
      prompt: Time.minute,
    },
  }

  constructor(options: AppOptions = {}) {
    super(() => true)
    if (!options.bots) options.bots = [options]
    this.options = merge(options, App.defaultConfig)

    defineProperty(this, '_hooks', {})
    defineProperty(this, '_commands', [])
    defineProperty(this, '_commandMap', {})
    defineProperty(this, '_shortcuts', [])
    defineProperty(this, '_shortcutMap', {})
    defineProperty(this, '_sessions', {})
    defineProperty(this, '_servers', {})
    defineProperty(this, '_userCache', {})
    defineProperty(this, '_groupCache', new LruCache({
      max: options.groupCacheLength,
      maxAge: options.groupCacheAge,
    }))

    if (options.port) this.createServer()
    for (const bot of options.bots) {
      let server = this.servers[bot.type]
      if (!server) {
        const constructor = Server.types[bot.type]
        if (!constructor) {
          const platform = bot.type.split(':', 1)[0]
          throw new Error(`unsupported platform "${platform}", you should import the adapter yourself`)
        }
        server = new constructor(this, bot)
        this.servers[bot.type] = server
      }
      server.create(bot)
    }

    this.prepare()

    // bind built-in event listeners
    this.middleware(this._preprocess.bind(this))
    this.on('message', this._onMessage.bind(this))
    this.on('tokenize', this._onShortcut.bind(this))
    this.before('connect', this._listen.bind(this))
    this.before('disconnect', this._close.bind(this))

    this.on('parse', (argv: Argv, session: Session) => {
      const { $prefix, $appel, subtype } = session
      // group message should have prefix or appel to be interpreted as a command call
      if (argv.root && subtype !== 'private' && $prefix === null && !$appel) return
      const name = argv.tokens[0]?.content
      if (name in this._commandMap) {
        argv.tokens.shift()
        return name
      }
    })

    this.on('before-attach-user', (session, fields) => {
      session.collect('user', session.$argv, fields)
    })

    this.on('before-attach-channel', (session, fields) => {
      session.collect('channel', session.$argv, fields)
    })

    this.plugin(validate)
    this.plugin(help)

    // suggest
    this.middleware((session, next) => {
      const { $argv, $reply, $parsed, $prefix, $appel, subtype } = session
      if ($argv || subtype !== 'private' && $prefix === null && !$appel) return next()
      const target = $parsed.split(/\s/, 1)[0].toLowerCase()
      if (!target) return next()

      const items = getCommands(session as any, this._commands).flatMap(cmd => cmd._aliases)
      return session.suggest({
        target,
        next,
        items,
        prefix: template('internal.command-suggestion-prefix'),
        suffix: template('internal.command-suggestion-suffix'),
        async apply(suggestion, next) {
          const newMessage = suggestion + $parsed.slice(target.length) + ($reply ? ' ' + $reply.content : '')
          return this.execute(newMessage, next)
        },
      })
    })
  }

  createServer() {
    const koa: Koa = new (require('koa'))()
    defineProperty(this, '_router', new (require('koa-router'))())
    koa.use(require('koa-bodyparser')())
    koa.use(this._router.routes())
    koa.use(this._router.allowedMethods())
    defineProperty(this, '_httpServer', http.createServer(koa.callback()))
  }

  prepare() {
    const { nickname, prefix } = this.options
    this.options.nickname = makeArray(nickname)
    this.options.prefix = Array.isArray(prefix) ? prefix : [prefix || '']
    this._nameRE = createLeadingRE(this.options.nickname, '@?', '([,，]\\s*|\\s+)')
    this._prefixRE = createLeadingRE(this.options.prefix)
  }

  async start() {
    this.status = AppStatus.opening
    await this.parallel('before-connect')
    this.status = AppStatus.open
    this.logger('app').debug('started')
    this.emit('connect')
  }

  private async _listen() {
    try {
      const { port } = this.app.options
      if (port) {
        this._httpServer.listen(port)
        this.logger('server').info('server listening at %c', port)
      }
      await Promise.all(Object.values(this.servers).map(server => server.listen()))
    } catch (error) {
      this._close()
      throw error
    }
  }

  async stop() {
    this.status = AppStatus.closing
    await this.parallel('before-disconnect')
    this.status = AppStatus.closed
    this.logger('app').debug('stopped')
    this.emit('disconnect')
  }

  private _close() {
    Object.values(this.servers).forEach(server => server.close())
    this.logger('server').debug('http server closing')
    this._httpServer?.close()
  }

  private async _preprocess(session: Session, next: NextFunction) {
    let message = this.options.processMessage(session.content)

    let capture: RegExpMatchArray, atSelf = false
    // eslint-disable-next-line no-cond-assign
    if (capture = message.match(/^\[CQ:reply,id=(-?\d+)\]\s*/)) {
      session.$reply = await session.$bot.getMessage(session.channelId, capture[1]).catch(noop)
      message = message.slice(capture[0].length)
      if (session.$reply) {
        const prefix = `[CQ:at,qq=${session.$reply.author.userId}]`
        message = message.slice(prefix.length).trimStart()
      }
    }

    // strip prefix
    const at = `[CQ:at,qq=${session.selfId}]`
    if (session.subtype !== 'private' && message.startsWith(at)) {
      atSelf = session.$appel = true
      message = message.slice(at.length).trimStart()
      // eslint-disable-next-line no-cond-assign
    } else if (capture = message.match(this._nameRE)) {
      session.$appel = true
      message = message.slice(capture[0].length)
      // eslint-disable-next-line no-cond-assign
    } else if (capture = message.match(this._prefixRE)) {
      session.$prefix = capture[0]
      message = message.slice(capture[0].length)
    }

    // store parsed message
    session.$parsed = message
    session.$argv = this.bail('tokenize', message, session) || Argv.parse(message)
    session.$argv.root = true
    session.$argv.session = session

    if (this.database) {
      if (session.subtype === 'group') {
        // attach group data
        const channelFields = new Set<Channel.Field>(['flag', 'assignee'])
        this.emit('before-attach-channel', session, channelFields)
        const group = await session.observeChannel(channelFields)

        // emit attach event
        if (await this.serial(session, 'attach-channel', session)) return

        // ignore some group calls
        if (group.flag & Channel.Flag.ignore) return
        if (group.assignee !== session.selfId && !atSelf) return
      }

      // attach user data
      const userFields = new Set<User.Field>(['flag'])
      this.emit('before-attach-user', session, userFields)
      const user = await session.observeUser(userFields)

      // emit attach event
      if (await this.serial(session, 'attach-user', session)) return

      // ignore some user calls
      if (user.flag & User.Flag.ignore) return
    }

    // execute command
    if (!session.resolve(session.$argv)) return next()
    return session.execute(session.$argv, next)
  }

  private async _onMessage(session: Session) {
    // preparation
    this._sessions[session.$uuid] = session
    const middlewares: Middleware[] = this._hooks[Context.middleware as any]
      .filter(([context]) => context.match(session))
      .map(([, middleware]) => middleware)

    // execute middlewares
    let index = 0, midStack = '', lastCall = ''
    const { prettyErrors } = this.options
    const next = async (fallback?: NextFunction) => {
      if (prettyErrors) {
        lastCall = new Error().stack.split('\n', 3)[2]
        if (index) {
          const capture = lastCall.match(/\((.+)\)/)
          midStack = `\n  - ${capture ? capture[1] : lastCall.slice(7)}${midStack}`
        }
      }

      try {
        if (!this._sessions[session.$uuid]) {
          throw new Error('isolated next function detected')
        }
        if (fallback) middlewares.push((_, next) => fallback(next))
        return await middlewares[index++]?.(session, next)
      } catch (error) {
        let stack = coerce(error)
        if (prettyErrors) {
          const index = stack.indexOf(lastCall)
          if (index >= 0) stack = stack.slice(0, index)
          stack += `Middleware stack:${midStack}`
        }
        this.logger('session').warn(`${session.content}\n${stack}`)
      }
    }
    await next()

    // update session map
    delete this._sessions[session.$uuid]
    this.emit(session, 'middleware', session)

    // flush user & group data
    await session.$user?._update()
    await session.$channel?._update()
  }

  private _onShortcut(content: string, { $prefix, $reply, $appel }: Session) {
    if ($prefix || $reply) return
    for (const shortcut of this._shortcuts) {
      const { name, fuzzy, command, greedy, prefix, options = {}, args = [] } = shortcut
      if (prefix && !$appel) continue
      if (typeof name === 'string') {
        if (!fuzzy && content !== name || !content.startsWith(name)) continue
        const message = content.slice(name.length)
        if (fuzzy && !$appel && message.match(/^\S/)) continue
        const argv: Argv = greedy
          ? { options: {}, args: [message.trim()] }
          : command.parse(Argv.parse(message.trim()))
        argv.command = command
        argv.options = { ...options, ...argv.options }
        argv.args = [...args, ...argv.args]
        return argv
      } else {
        const capture = name.exec(content)
        if (!capture) continue
        function escape(source: any) {
          if (typeof source !== 'string') return source
          source = source.replace(/\$\$/g, '@@__PLACEHOLDER__@@')
          capture.map((segment, index) => {
            if (!index || index > 9) return
            source = source.replace(new RegExp(`\\$${index}`, 'g'), (segment || '').replace(/\$/g, '@@__PLACEHOLDER__@@'))
          })
          return source.replace(/@@__PLACEHOLDER__@@/g, '$')
        }
        return {
          command,
          args: args.map(escape),
          options: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, escape(v)])),
        }
      }
    }
  }
}
