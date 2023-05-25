import { spawn, SpawnOptions } from 'child_process';
import { createReadStream } from 'fs';
import { parse } from 'subtitle';
import path from 'path';
import winston from 'winston';
import { PeriscopeApi } from '../apis/PeriscopeApi';
import { logger as baseLogger } from '../logger';
import { Util } from '../utils/Util';
import { CaptionPhrase } from '../interfaces/Twitter.interface';

const phrases = [
	{
		raw: [
			'NJF',
			'N J F'
		],
		fmt: 'NJF'
	},
	{
		raw: [
			'Fuentes',
			'Nick Fuentes',
			'Nicholas Fuentes',
			'Nicholas J Fuentes'
		],
		fmt: 'Nick Fuentes'
	},
	{
		raw: [
			'AFPAC',
			'AFPAK',
			'F Pack'
		],
		fmt: 'AFPAC'
	},
	{
		raw: [
			'America First'
		],
		fmt: 'America First'
	},
	{
		raw: [
			'groyper',
			'groypur',
			'groipper',
			'groiper',
			'grouper',
			'gripper',
			'graper',
			'griper',
			'criper'
		],
		fmt: 'groyper'
	},
	{
		raw: [
			'Cozy TV',
			'Cozy Dot TV',
			'CozyTV'
		],
		fmt: 'cozy.tv'
	},
	{
		raw: [
			'Bronze Age'
		],
		fmt: 'Bronze Age'
	},
	{
		raw: [
			'Claremont',
			'Clairmont',
			'Claremount',
		],
		fmt: 'Claremont'
	},
	{
		raw: [
			'National Conservatism',
			'National Conservative',
			'NatCon',
			'Nacon',
			'Nakon'
		],
		fmt: 'NatCon'
	},
	{
		raw: [
			"Where\'s my keys",
			"Where is my keys",
			"Where are my keys"
		],
		fmt: "ACTIVATION PHRASE"
	},
	{
		raw: [
			"Goose"
		],
		fmt: "Goose"
	},
	{
		raw: [
			"Spoods",
			"Spoons",
			"Spoodz",
			"Spooz",
			"Spuz",
			"Spoos"
		],
		fmt: "Spoods"
	},
	{
		raw: [
			"Chief Trumpster",
			"Chief Trump"
		],
		fmt: "Chief Trumpster"
	}
].map((phrase) => {
	return {
		regexp: new RegExp(phrase.raw.join('|'), 'gi'),
		format: phrase.fmt
	}
})

export class SpaceDownloader {
	private logger: winston.Logger

	private directory: string
	private playlistUrl: string
	private playlistFile: string
	private audioFile: string
	private subsFile: string
	private timeStarted: number

	constructor(
		private readonly originUrl: string,
		private readonly filename: string,
		private readonly subDir = '',
		private readonly started_at: number,
		private readonly metadata?: Record<string, any>
	) {
		this.logger = baseLogger.child({ label: '[Audio]' })
		this.directory = Util.getMediaDir(subDir);
		this.playlistFile = path.join(this.directory, `${filename}.m3u8`)
		this.audioFile = path.join(this.directory, `${filename}.mp3`)
		this.subsFile = path.join(this.directory, `${filename}.mp3.vtt`);
		this.timeStarted = started_at;
	}

	public async download(live = false) {
		if (live) {
			this.playlistUrl = this.originUrl
		} else {
			this.playlistUrl = await PeriscopeApi.getFinalPlaylistUrl(this.originUrl)
		}

		// Util.createMediaDir(this.subDir)
		// await this.saveFinalPlaylist()
		Util.createMediaDir(this.subDir)
		await this.spawnFFMPEG(live);
		await this.spawnWhisper(live);
		return await this.processCaptions();
	}

	private spawnFFMPEG(live = false) {
		const time = Date.now();

		const cmd = 'ffmpeg';
		const args = [];
		if (live) {
			// limit to 30 seconds for live transcription
			args.push('-t', '30');
		}
		args.push(
			'-y',
			'-protocol_whitelist',
			'file,https,tls,tcp',
			'-i',
			this.playlistUrl
		);
		// metadata for audio file
		if (this.metadata) {
			Object.keys(this.metadata).forEach((key) => {
				const value = this.metadata[key];
				if (!value) return;
				args.push('-metadata', `${key}=${value}`)
			});
		}
		// output file
		args.push(this.audioFile)

		// https://github.com/nodejs/node/issues/21825
		const spawnOptions: SpawnOptions = {
			cwd: process.cwd(),
			stdio: 'ignore',
			detached: false,
			windowsHide: true
		}
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const cp = process.platform === 'win32'
			? spawn(process.env.comspec, ['/c', cmd, ...args], spawnOptions)
			: spawn(cmd, args, spawnOptions);

		const logger = this.logger;
		return new Promise((resolve, reject) => {
			cp.on('close', function (code) {
				const seconds = Math.round(((Date.now() - time) / 1000) * 10) / 10;
				logger.info(`Audio downloaded after ${seconds}s`);
				resolve(true);
			});
			cp.on('error', function (error) {
				reject(error);
			});
		});
	}

	private spawnWhisper(live = false) {
		const time = Date.now();
		const logger = this.logger;
		return new Promise((resolve, reject) => {
			const cmd = 'whisper';
			const args = [
				this.audioFile
			];
			if (live) {
				args.push('--model', 'base.en');
			} else {
				args.push('--model', 'small.en');
			}

			const spawnOptions: SpawnOptions = {
				cwd: this.directory,
				stdio: 'pipe',
				detached: false,
				windowsHide: true,
			};
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const cp = process.platform === 'win32'
				? spawn(process.env.comspec, ['/c', cmd, ...args], spawnOptions)
				: spawn(cmd, args, spawnOptions);

			cp.on('close', function (code) {
				const seconds = Math.round(((Date.now() - time) / 1000) * 10) / 10;
				logger.info(`Audio transcribed after ${seconds}s`);
				resolve(true);
			});
			cp.on('error', function (error) {
				reject(error);
			});
		});
	};

	private processCaptions(): Promise<CaptionPhrase[]> {
		const time = Date.now();
		const time_started = this.timeStarted;
		const elapsed = (time_started > 0) ? (time - time_started) : 0;

		const caption_phrases = [];

		const logger = this.logger;
		return new Promise((resolve, reject) => {
			let match = false;
			try {
				createReadStream(this.subsFile)
					.pipe(parse())
					.on('data', function (node) {
						if (node.type === 'cue') {
							let text = node.data.text.replace(/[.,#!\^;:{}=_`~()]/g, '');
							phrases.forEach((phrase) => {
								if (phrase.regexp.test(text)) {
									text = text.replaceAll(phrase.regexp, '**' + phrase.format + '**');
									match = true;
								}
							});
							caption_phrases.push(new CaptionPhrase(node.data.start + elapsed, text));
						}
					})
					.on('error', function(error) {
						logger.error('Failed to process captions ' + error);
						resolve([]);
					})
					.on('finish', function () {
						const seconds = Math.round(((Date.now() - time) / 1000) * 10) / 10;
						logger.debug(`Captions scanned in ${seconds}s`);
						if (match === true) {
							resolve(caption_phrases);
						} else {
							resolve([]);
						}
					});
			} catch(error) {
				if (error.code === 'ENOENT') {
					logger.error(`Captions file '${this.subsFile}' not found`);
				} else {
					logger.error('Failed to process captions ' + error.message);
				}
				resolve([]);
			}
		});
	};
};