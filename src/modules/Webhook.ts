import { time } from '@discordjs/builders'
import axios, { AxiosRequestConfig } from 'axios'
import winston from 'winston'
import fs from 'fs';
import path from 'path';
import { AudioSpaceMetadataState } from '../enums/Twitter.enum'
import { AudioSpace } from '../interfaces/Twitter.interface'
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
	};

	// eslint-disable-next-line class-methods-use-this
	private get config() {
		return configManager.config?.webhooks
	};

	public send() {
		const space_info = this.getSpaceInfo();
		return Promise.all([
			this.send_discord(space_info),
			this.send_cozy_captions(space_info)
		]);
	};

	private async send_discord(space_info) {
		this.logger.debug('Sending Discord Webhooks...');

		const configs = Array.from(this.config?.discord || []);
		for(let i=0; i<configs.length; i++) {
			const config = configs[i];

			// check if discord webhook is active
			if (!config.active) continue;
			// gather discord webhook urls
			const urls = Array.from(config.urls || [])
				.filter((v) => v);
			// gather discord usernames to mention
			const usernames = Array.from(config.usernames || [])
				.filter((v) => v)
				.map((v) => v.toLowerCase())
			// don't send if no urls or usernames
			if ((urls.length < 1) && (usernames.length < 1)) continue;
			// unknown
			// if (!usernames.find((v) => v === '<all>') && usernames.every((v) => !SpaceUtil.isParticipant(this.audioSpace, v))) continue;

			let content = '';
			// mention discord users about live space
			if (this.audioSpace.metadata.state === AudioSpaceMetadataState.RUNNING) {
				Array.from(config.mentions?.roleIds || [])
					.filter((v) => v)
					.forEach((roleId) => {
						content += `<@&${roleId}> `;
					});
				Array.from(config.mentions?.userIds || [])
					.filter((v) => v)
					.forEach((userId) => {
						content += `<@${userId}> `;
					});
				content = [content, config.startMessage]
					.filter((v) => v)
					.map((v) => v.trim())
					.join(' ');
			}
			// mention discord users about ended space
			if (this.audioSpace.metadata.state === AudioSpaceMetadataState.ENDED) {
				content = [content, config.endMessage]
					.filter((v) => v)
					.map((v) => v.trim())
					.join(' ');
			}
			content = content.trim();

			try {
				// prepare discord webhook payload
				const payload = {
					content,
					embeds: [this.embed_create(space_info)],
				};
				// prepare discord webhook file payload
				let payloadFile;
				await fs.promises.stat(this.audioFile)
					.then((stats) => {
						if (stats) {
							payloadFile = this.audio_payload();
						}
					})
					.catch((error) => {
						this.logger.error('Failed to locate audio file');
					});
				// send discord webhooks
				for(let j=0; j<urls.length; j++) {
					if (payload) {
						await axios.post(urls[j], payload);
					}
					if (payloadFile) {
						await payloadFile.submit(urls[j]);
					}
				}
			} catch (error) {
				this.logger.error(`Failed to send Discord webhooks: ${error.message}`);
				return false;
			}
		}
		return true;
	};

	private send_cozy_captions(space_info) {
		this.logger.debug('Sending Cozy Captions webhooks...');

		// send cozy captions webhook
		const body = {
			'space': space_info
		};
		return fetch('https://cozycaptions.com/twitter-crawler/create', { 'method': 'PUT', 'headers': { 'Content-Type': 'application/json' }, 'body': JSON.stringify(body) })
			.then((response) => response.json())
			.then((response) => {
				if (response.error) throw Error(response.error);
				return true;
			})
			.catch((error) => {
				this.logger.error(`Failed to send Cozy Captions webhook: ${error}`);
				return false;
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

	private embed_create(space_info: any) {
		// fields
		const fields: any[] = [];

		// space started
		if ([AudioSpaceMetadataState.RUNNING].includes(this.audioSpace.metadata.state as any)) {
			fields.push({
				name: '▶️ Started at',
				value: Webhook.embed_local_time(space_info.date_started.getTime()),
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
					value: Webhook.embed_local_time(Number(this.audioSpace.metadata.ended_at)),
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

	public static embed_local_time(ms: number) {
		if (!ms) {
			return null;
		}
		return [
			time(Math.floor(ms / 1000)),
			time(Math.floor(ms / 1000), 'R'),
		].join('\n');
	}

	private audio_payload() {
		const form_data = new FormData();
		form_data.append('username', SpaceUtil.getHostUsername(this.audioSpace));
		form_data.append('avatar_url', SpaceUtil.getHostProfileImgUrl(this.audioSpace));
		form_data.append('file', fs.createReadStream(this.audioFile));
		return form_data;
	};
}
