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
  const start = hex.indexOf('#') === 0 ? 1 : 0;
  const rrggbb = hex.slice(start, start+2) + hex.slice(start+2, start+4) + hex.slice(start+4, start+6);
  return parseInt(rrggbb, 16);
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
    this.audioFile = path.join(this.directory, `${filename}.ogg`);
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
		this.logger.debug('sendDiscord');
		const configs = Array.from(this.config?.discord || []);
		configs.forEach((config) => {
			if (!config.active) {
				return;
			}
			const urls = Array.from(config.urls || [])
				.filter((v) => v)
			const usernames = Array.from(config.usernames || [])
				.filter((v) => v)
				.map((v) => v.toLowerCase())
			if (!urls.length || !usernames.length) {
				return;
			}
			if (!usernames.find((v) => v === '<all>') && usernames.every((v) => !SpaceUtil.isParticipant(this.audioSpace, v))) {
				return;
			}

			const space_info = this.getSpaceInfo();

			try {
				// Build content with mentions
				let content = '';
				if (this.audioSpace.metadata.state === AudioSpaceMetadataState.RUNNING) {
					Array.from(config.mentions?.roleIds || []).map((v) => v).forEach((roleId) => {
						content += `<@&${roleId}> `;
					})
					Array.from(config.mentions?.userIds || []).map((v) => v).forEach((userId) => {
						content += `<@${userId}> `;
					})
					content = [content, config.startMessage].filter((v) => v).map((v) => v.trim()).join(' ');
				}
				if (this.audioSpace.metadata.state === AudioSpaceMetadataState.ENDED) {
					content = [content, config.endMessage].filter((v) => v).map((v) => v.trim()).join(' ');
				}
				content = content.trim();

				// prepare discord webhook payload
				const payload = {
					content,
					embeds: [this.getEmbed(space_info)],
				};
				// prepare discord webhook file payload
				let payloadFile;
				try {
					const stats = fs.statSync(this.audioFile);
					if (stats) {
						payloadFile = this.getFilePayload();
					}
				} catch (error) {
					this.logger.error('Audio file not found');
				}
				// send discord webhooks
				urls.forEach((url) => discordWebhookLimiter.schedule(() => {
					this.post(url, payload);
					if (payloadFile) {
						payloadFile.submit(url);
					}
					return Promise.resolve(null);
				}));
			} catch (error) {
				this.logger.error(`sendDiscord: ${error.message}`);
			}

			// send cozy captions webhook
			const body = {
				'space': space_info
			}
			fetch('https://cozycaptions.com/twitter-crawler/create', { 'method': 'PUT', 'headers': { 'Content-Type': 'application/json' }, 'body': JSON.stringify(body) })
				.then((response) => response.json())
				.then((response) => {
					if (response.error) throw Error(response.error);
				})
				.catch((error) => {
					this.logger.error(`sendCozycaptions: ${error}`);
				});
		});
	};

	private getSpaceInfo() {
		const host_username = SpaceUtil.getHostUsername(this.audioSpace);

		const info = {
			'host': host_username,
			'title': SpaceUtil.getTitle(this.audioSpace),
			'category': "Other",
			'color': "#a0a0a1",
			'space_url': TwitterUtil.getSpaceUrl(SpaceUtil.getId(this.audioSpace)),
			'playlist_url': this.masterUrl,
			'date_started': new Date(),
			'captions': [],
			'speakers': [],
			'listener_count': undefined
		};

		// category
		const space_host = (configManager.config?.users || []).find((user) => user.username.toLowerCase() === info.host.toLowerCase());
		if (space_host) {
		  	info.category = space_host?.category ?? "Other";
		}
		// color
		const space_category = (configManager.config?.categories || []).find((category) => category.name.toLowerCase() === info.category.toLowerCase());
		if (space_category) {
			info.color = space_category?.color ?? "#a0a0a1";
		}
		// date started
		if (this.audioSpace.metadata.started_at) {
			info.date_started = new Date(this.audioSpace.metadata.started_at);
		}
		// captions
		if (Array.isArray(this.audioSpace.detected_phrases)) {
			info.captions = this.audioSpace.detected_phrases;
		}
		// speakers
		const space_hosts = SpaceUtil.getAdmins(this.audioSpace);
		const space_speakers = SpaceUtil.getSpeakers(this.audioSpace);
		if ((space_hosts.length + space_speakers.length) >= 1) {
			// admins
			space_hosts.forEach((user) => {
				const role = (user.twitter_screen_name === info.host) ? 'host' : 'co-host';
				info.speakers.push({
					'username': user.twitter_screen_name,
					'nickname': (role === 'host') ? SpaceUtil.getHostName(this.audioSpace) : undefined,
					'photo_url': (role === 'host') ? SpaceUtil.getHostProfileImgUrl(this.audioSpace) : undefined,
					'flags': {
						'role': (user.twitter_screen_name === info.host) ? 'host' : 'co-host',
						'muted': (user.is_muted_by_admin || user.is_muted_by_guest) ? true : false
					}
				});
			});
			// speakers
			space_speakers.forEach((user) => {
				info.speakers.push({
					'username': user.twitter_screen_name,
					'flags': {
						'role': 'speaker',
						'muted': (user.is_muted_by_admin || user.is_muted_by_guest) ? true : false
					}
				});
			});
		}

		return info;
	};

	private getEmbed(space_info: any) {
		// fields
		const fields: any[] = [];

		// space started
		if ([AudioSpaceMetadataState.RUNNING].includes(this.audioSpace.metadata.state as any)) {
			fields.push({
				name: '▶️ Started at',
				value: Webhook.getEmbedLocalTime(space_info.date_started.getTime()),
				inline: true,
			});

			// space links
			if (space_info.space_url && space_info.playlist_url) {
				fields.push({
					name: '🔗 Links',
					value: `[🌌 Twitter Space](${space_info.space_url}) [📡 M3U8 Stream](${space_info.playlist_url})`,
				});
			}
		}

		// space ended
		if ([AudioSpaceMetadataState.ENDED].includes(this.audioSpace.metadata.state as any)) {
			if (this.audioSpace.metadata.ended_at) {
				fields.push({
					name: '⏹️ Ended at',
					value: Webhook.getEmbedLocalTime(Number(this.audioSpace.metadata.ended_at)),
					inline: true,
				});
			}
		}

		// captions snapshot
		if (space_info.captions.length >= 1) {
			const captions = space_info.captions.map((caption) => ms_to_hhmmss(caption.ts) + ' ' + caption.text);
			fields.push({
				name: 'Snapshot',
				value: captions.join('\n')
			});
		}

		if (space_info.speakers.length >= 1) {
			const speakers_active = space_info.speakers.filter((speaker) => speaker.flags.muted === false);
			const speakers_inactive = space_info.speakers.filter((speaker) => speaker.flags.muted === true);
			// speaking participants
			fields.push({
				name: '🎙️ Active Speakers',
				value: speakers_active.map((s) => `[${(s.flags.role === 'host' || s.flags.role === 'co-host') ? '👑' : ''}${s.username}](https://twitter.com/${s.username})`).join(', ')
			});
			// muted participants
			fields.push({
				name: '🔇 Muted Speakers',
				value: speakers_inactive.map((s) => `[${(s.flags.role === 'host' || s.flags.role === 'co-host') ? '👑' : ''}${s.username}](https://twitter.com/${s.username})`).join(', ')
			});
		}

		const speaker_host = space_info.speakers.find((speaker) => speaker.flags.role === 'host');
		const host_nickname = speaker_host?.nickname ?? 'Unknown';
		const host_username = speaker_host?.username ?? '';
		const host_photo_url = speaker_host?.photo_url ?? '';

		return {
			type: 'rich',
			title: space_info.title,
			description: 'Category: ' + space_info.category,
			color: hex_to_integer(space_info.color),
			author: {
				name: `${host_nickname} (@${host_username})`,
				url: 'https://twitter.com/' + host_username,
				icon_url: host_photo_url
			},
			fields,
			footer: {
				text: 'Twitter',
				icon_url: 'https://abs.twimg.com/favicons/twitter.2.ico',
			}
		};
	};

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
