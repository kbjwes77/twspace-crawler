export interface Config {
  interval?: number

  users?: ({
    username: string,
    category: string
  })[]
  categories?: ({
    name: string,
    color: string
  })[]

  webhooks?: {
    discord?: {
      active: boolean
      urls: string[]
      usernames: ('<all>' | string)[]
      mentions?: {
        roleIds?: string[]
        userIds?: string[]
      }
      startMessage?: string
      endMessage?: string
    }[]
  }
}
