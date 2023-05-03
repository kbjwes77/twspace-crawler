import { codeBlock, inlineCode, time } from '@discordjs/builders'
import axios, { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import winston from 'winston'
import fs from 'fs';
import path from 'path';
import { AudioSpaceMetadataState } from '../enums/Twitter.enum'
import { AudioSpace } from '../interfaces/Twitter.interface'
import { discordWebhookLimiter } from '../Limiter'
import { logger as baseLogger } from '../logger'
import { Util } from '../utils/Util'
import { SpaceUtil } from '../utils/SpaceUtil'
import { TwitterUtil } from '../utils/TwitterUtil'
import { configManager } from './ConfigManager'
import FormData from 'form-data';

const ms_to_hhmmss = function (ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / 1000 / 60) % 60);
  const hours = Math.floor((ms / 1000 / 60 / 60) % 24);

  return [
      hours.toString().padStart(2, "0"),
      minutes.toString().padStart(2, "0"),
      seconds.toString().padStart(2, "0")
  ].join(":");
};

const hex_to_integer = function(hex: string): number {
  const start = hex.indexOf('0x') === 0 ? 2 : 0;
  const bbggrr = hex.slice(start+4, start+6) + hex.slice(start+2, start+4) + hex.slice(start, start+2);
  return parseInt(bbggrr, 16);
};

export class Webhook {
  private logger: winston.Logger
  private audiospace: AudioSpace
  private directory: string
  private audioFile: string

  constructor(
    private readonly audioSpace: AudioSpace,
    private readonly masterUrl: string,
    private readonly filename: string,
    private readonly subDir: string
  ) {
    this.audiospace = audioSpace;
    this.directory = Util.getMediaDir(subDir);
    this.audioFile = path.join(this.directory, `${filename}.mp3`);
    const username = SpaceUtil.getHostUsername(audioSpace);
    const spaceId = SpaceUtil.getId(audioSpace);
    this.logger = baseLogger.child({ label: `[Webhook] [${username}] [${spaceId}]` });
  }

  // eslint-disable-next-line class-methods-use-this
  private get config() {
    return configManager.config?.webhooks
  }

  public send() {
    this.sendDiscord()
  }

  private async post(url: string, body: any) {
    const requestId = randomUUID()
    try {
      this.logger.debug('--> post', {
        requestId,
        url: url.replace(/.{60}$/, '****')
      })
      const { data } = await axios.post(url, body)
      this.logger.debug('<-- post', { requestId })
      return data
    } catch (error) {
      this.logger.error(`post: ${error.message}`, { requestId })
    }
    return null
  }

  private sendDiscord() {
    this.logger.debug('sendDiscord')
    const configs = Array.from(this.config?.discord || [])
    configs.forEach((config) => {
      if (!config.active) {
        return
      }
      const urls = Array.from(config.urls || [])
        .filter((v) => v)
      const usernames = Array.from(config.usernames || [])
        .filter((v) => v)
        .map((v) => v.toLowerCase())
      if (!urls.length || !usernames.length) {
        return
      }
      if (!usernames.find((v) => v === '<all>') && usernames.every((v) => !SpaceUtil.isParticipant(this.audioSpace, v))) {
        return
      }
      try {
        // Build content with mentions
        let content = ''
        if (this.audioSpace.metadata.state === AudioSpaceMetadataState.RUNNING) {
          Array.from(config.mentions?.roleIds || []).map((v) => v).forEach((roleId) => {
            content += `<@&${roleId}> `
          })
          Array.from(config.mentions?.userIds || []).map((v) => v).forEach((userId) => {
            content += `<@${userId}> `
          })
          content = [content, config.startMessage].filter((v) => v).map((v) => v.trim()).join(' ')
        }
        if (this.audioSpace.metadata.state === AudioSpaceMetadataState.ENDED) {
          content = [content, config.endMessage].filter((v) => v).map((v) => v.trim()).join(' ')
        }
        content = content.trim()

        const phrases: string[] = [];
        if ((Array.isArray(this.audiospace.detected_phrases)) && (this.audiospace.detected_phrases.length >= 1)) {
          this.audiospace.detected_phrases.forEach((phrase) => {
            const hhmmss = ms_to_hhmmss(phrase.ts);
            phrases.push(hhmmss + ' ' + phrase.text);
          });
        }

        // Build request payload
        const payload = {
          content,
          embeds: [this.getEmbed(usernames, phrases)],
        };
        let payloadFile;
        try {
          const stats = fs.statSync(this.audioFile);
          if (stats) {
            payloadFile = this.getFilePayload();
          }
        } catch (error) {
          this.logger.error('Audio file not found');
        }
        // Send
        urls.forEach((url) => discordWebhookLimiter.schedule(() => {
          this.post(url, payload);
          if (payloadFile) {
            payloadFile.submit(url);
          }
          return Promise.resolve(null);
        }));
      } catch (error) {
        this.logger.error(`sendDiscord: ${error.message}`)
      }
    })
  }

  private getEmbedTitle(usernames: string[]): string {
    const hostUsername = SpaceUtil.getHostUsername(this.audioSpace)
    const host = inlineCode(hostUsername)

    if (this.audioSpace.metadata.state === AudioSpaceMetadataState.ENDED) {
      return `${host} Space ended`
    }

    if (!usernames.some((v) => v.toLowerCase() === hostUsername.toLowerCase())
      && usernames.some((v) => SpaceUtil.isAdmin(this.audioSpace, v))) {
      const participants = usernames
        .map((v) => SpaceUtil.getParticipant(this.audioSpace.participants.admins, v))
        .filter((v) => v)
      if (participants.length) {
        const guests = participants
          .map((v) => inlineCode(v.twitter_screen_name))
          .join(', ')
        return `${guests} is co-hosting ${host}'s Space`
      }
    }

    if (usernames.some((v) => SpaceUtil.isSpeaker(this.audioSpace, v))) {
      const participants = usernames
        .map((v) => SpaceUtil.getParticipant(this.audioSpace.participants.speakers, v))
        .filter((v) => v)
      if (participants.length) {
        const guests = participants
          .map((v) => inlineCode(v.twitter_screen_name))
          .join(', ')
        return `${guests} is speaking in ${host}'s Space`
      }
    }

    if (usernames.some((v) => SpaceUtil.isListener(this.audioSpace, v))) {
      const participants = usernames
        .map((v) => SpaceUtil.getParticipant(this.audioSpace.participants.listeners, v))
        .filter((v) => v)
      if (participants.length) {
        const guests = participants
          .map((v) => inlineCode(v.twitter_screen_name))
          .join(', ')
        return `${guests} is listening in ${host}'s Space`
      }
    }

    return `${host} is hosting a Space`
  }

  private getEmbed(usernames: string[], phrases: string[]) {
    const username = SpaceUtil.getHostUsername(this.audioSpace);
    const name = SpaceUtil.getHostName(this.audioSpace);

    let space_category_name = "";
    const space_host = (configManager.config?.users || []).find((user) => user.username.toLowerCase() === username.toLowerCase());
    if (space_host) {
      space_category_name = space_host.category ?? "";
    }
    let space_color = "0xa0a0a1";
    if (space_category_name) {
      /** @todo fix space category color not working */
      const space_category = (configManager.config?.categories || []).find((category) => category.name.toLowerCase() === space_category_name.toLowerCase());
      if (space_category) {
        space_color = space_category.color ?? "0xa0a0a1";
        this.logger.info('space color hex: ' + space_color);
        this.logger.info('space color dec: ' + hex_to_integer(space_color));
      }
    }

    const fields: any[] = [{
        name: (space_category_name) ? 'Category: ' + space_category_name : 'Other',
        value: codeBlock(SpaceUtil.getTitle(this.audioSpace))
    }];

    if ([AudioSpaceMetadataState.RUNNING, AudioSpaceMetadataState.ENDED].includes(this.audioSpace.metadata.state as any)) {
      if (this.audioSpace.metadata.started_at) {
        fields.push({
            name: '▶️ Started at',
            value: Webhook.getEmbedLocalTime(this.audioSpace.metadata.started_at),
            inline: true,
        });
      }
    }

    if ([AudioSpaceMetadataState.ENDED].includes(this.audioSpace.metadata.state as any)) {
      if (this.audioSpace.metadata.ended_at) {
        fields.push({
            name: '⏹️ Ended at',
            value: Webhook.getEmbedLocalTime(Number(this.audioSpace.metadata.ended_at)),
            inline: true,
        });
      }
    }

    if (phrases.length >= 1) {
      fields.push({
        name: 'Detected Phrases',
        value: phrases.join('\n')
      });
    }

    /*
    if ([AudioSpaceMetadataState.RUNNING, AudioSpaceMetadataState.ENDED].includes(this.audioSpace.metadata.state as any)) {
      fields.push(
        {
          name: 'Playlist url',
          value: codeBlock(this.masterUrl),
        },
      )
    }
    */

    const embed = {
      type: 'rich',
      title: this.getEmbedTitle(usernames),
      description: TwitterUtil.getSpaceUrl(SpaceUtil.getId(this.audioSpace)),
      color: hex_to_integer(space_color),
      author: {
        name: `${name} (@${username})`,
        url: TwitterUtil.getUserUrl(username),
        icon_url: SpaceUtil.getHostProfileImgUrl(this.audioSpace),
      },
      fields,
      footer: {
        text: 'Twitter',
        icon_url: 'https://abs.twimg.com/favicons/twitter.2.ico',
      },
    }

    return embed
  }

  public static getEmbedLocalTime(ms: number) {
    if (!ms) {
      return null
    }
    return [
      time(Math.floor(ms / 1000)),
      time(Math.floor(ms / 1000), 'R'),
    ].join('\n')
  }

  public getFilePayload() {
    const form_data = new FormData();
    form_data.append('username', SpaceUtil.getHostUsername(this.audioSpace));
    form_data.append('avatar_url', SpaceUtil.getHostProfileImgUrl(this.audioSpace));
    form_data.append('file', fs.createReadStream(this.audioFile));
    return form_data;
  };
}
