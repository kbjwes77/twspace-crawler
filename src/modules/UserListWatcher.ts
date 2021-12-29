import EventEmitter from 'events'
import winston from 'winston'
import { TwitterApi } from '../apis/TwitterApi'
import { TWITTER_AUTHORIZATION } from '../constants/twitter.constant'
import { SpaceState } from '../enums/Twitter.enum'
import { logger as baseLogger } from '../logger'
import { Util } from '../utils/Util'

export class UserListWatcher extends EventEmitter {
  private readonly CHUNK_SIZE = 100

  private logger: winston.Logger

  private users: { id: string, username: string }[] = []
  private usernameChunks: string[][] = []

  constructor(private usernames: string[]) {
    super()
    this.logger = baseLogger.child({ label: '[UserListWatcher]' })
    this.logger.info(`Usernames: ${usernames}`)
    this.logger.info(`Username count: ${usernames.length}`)
    this.usernameChunks = [...Array(Math.ceil(usernames.length / this.CHUNK_SIZE))]
      .map(() => usernames.splice(0, this.CHUNK_SIZE))
    this.logger.info(`User chunk count: ${this.usernameChunks.length}`)
  }

  public async watch(): Promise<void> {
    this.logger.info('Starting...')
    try {
      await this.initUsers()
      const idChunks = this.usernameChunks
        .map((chunk) => chunk
          .map((username) => this.users
            .find((user) => user.username.toLowerCase() === username.toLowerCase())?.id)
          .filter((v) => v))
      this.logger.info('Watching...')
      idChunks.forEach((idChunk) => this.getSpaces(idChunk))
    } catch (error) {
      const { status, headers, data } = (error.response || {})
      this.logger.error(`watch: ${error.message}`, {
        response: { status, data, headers },
      })

      let timeoutMs = 5000
      // Rate limit exceeded
      if (status === 429) {
        const xRateLimitReset = Number(headers?.['x-rate-limit-reset']) * 1000
        if (xRateLimitReset) {
          timeoutMs = Math.max(xRateLimitReset - Date.now(), timeoutMs)
        }
      }
      this.logger.info(`Retry in ${timeoutMs}ms`)
      setTimeout(() => this.watch(), timeoutMs)
    }
  }

  private async initUsers() {
    const responses = await Promise.all(
      this.usernameChunks.map((v) => TwitterApi.getUsersLookup(
        v,
        { authorization: TWITTER_AUTHORIZATION },
      )),
    )
    this.users = []
    responses.forEach((users) => {
      users.forEach((user) => {
        this.users.push({
          id: user.id_str,
          username: user.screen_name,
        })
      })
    })
    this.logger.debug(`User list: ${JSON.stringify(this.users)}`)
  }

  private async getSpaces(ids: string[]) {
    this.logger.debug('>>> getSpaces', { ids })
    try {
      const { data: spaces } = await TwitterApi.getSpacesByCreatorIds(
        ids,
        { authorization: Util.getTwitterAuthorization() },
      )
      this.logger.debug('<<< getSpaces', { spaces })
      const liveSpaces = (spaces || []).filter((v) => v.state === SpaceState.LIVE)
      if (liveSpaces.length) {
        this.logger.debug(`Live space ids: ${liveSpaces.map((v) => v.id).join(', ')}`)
        liveSpaces.forEach((space) => this.emit('data', space.id))
      }
    } catch (error) {
      this.logger.error(`getSpaces: ${error.message}`, {
        response: {
          data: error.response?.data,
          headers: error.response?.headers,
        },
      })
    }
    setTimeout(() => this.getSpaces(ids), Util.getUserRefreshInterval())
  }
}