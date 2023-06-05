import { spawn, SpawnOptions } from 'child_process';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { parse } from 'subtitle';
import path from 'path';
import winston from 'winston';
import { PeriscopeApi } from '../apis/PeriscopeApi';
import { logger as baseLogger } from '../logger';
import { Util } from '../utils/Util';
import { CaptionPhrase } from '../interfaces/Twitter.interface';

const keywords = [
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
			"Chief Trump",
			"Chief Chumster"
		],
		fmt: "Chief Trumpster"
	}
].map((phrase) => {
	return {
		regexp: new RegExp(phrase.raw.join('|'), 'gi'),
		format: phrase.fmt
	}
});

const STATUS = new Set([
	'pending',
	'in-progress',
	'complete',
	'error'
]);

export class SpaceDownloader {
	private logger: winston.Logger;

	private directory: string;
	private playlistUrl: string;
	private timeStarted: number;
	public system: {
		ffmpeg: {
			status: string,
			file: string
		},
		whisper: {
			status: string,
			file: string
		},
		captions: {
			status: string,
			file: string
		},
		phrases: CaptionPhrase[]
	};

	constructor(
		private readonly originUrl: string,
		private readonly filename: string,
		private readonly subDir = '',
		private readonly started_at: number,
		private readonly metadata?: Record<string, any>
	) {
		this.logger = baseLogger.child({ label: '[Downloader]' });
		this.directory = Util.getMediaDir(subDir);
		this.playlistUrl = originUrl;
		this.timeStarted = started_at;
		this.system = {
			'ffmpeg': {
				'status': 'pending',
				'file': path.join(this.directory, `${filename}.ogg`),
			},
			'whisper': {
				'file': path.join(this.directory, `${filename}.ogg`),
				'status': 'pending'
			},
			'captions': {
				'file': path.join(this.directory, `${filename}.ogg.vtt`),
				'status': 'pending'
			},
			'phrases': []
		};
	};

	public async download(live = false) {
		// create directory for downloads
		Util.createMediaDir(this.subDir);

		if (!live) {
			// master playlist url
			this.playlistUrl = await PeriscopeApi.getFinalPlaylistUrl(this.playlistUrl);
		}

		if (this.system.ffmpeg.status === 'pending') {
			// download stream audio
			await this.download_audio(live);
		}
		if ((this.system.whisper.status === 'pending') && (this.system.ffmpeg.status === 'complete')) {
			// transcribe audio
			await this.transcribe_audio(live);
		}
		if ((this.system.captions.status === 'pending') && (this.system.whisper.status === 'complete')) {
			// process captions
			await this.process_captions(live);
		}
		if (this.system.captions.status === 'complete') {
			return true;
		}
		return false;
	};

	private download_audio(live = false): Promise<Boolean> {
		const downloader = this;
		downloader.system.ffmpeg.status = 'in-progress';
		downloader.logger.info('Downloading audio...');
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
			downloader.playlistUrl
		);
		// metadata for audio file
		if (downloader.metadata) {
			Object.keys(downloader.metadata).forEach((key) => {
				const value = downloader.metadata[key];
				if (!value) return;
				args.push('-metadata', `${key}=${value}`)
			});
		}
		// output file
		args.push(downloader.system.ffmpeg.file);

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

		return new Promise((resolve, reject) => {
			cp.on('close', function (code) {
				downloader.system.ffmpeg.status = 'complete';
				const elapsed = Math.round((Date.now() - time) / 100) / 10;
				downloader.logger.info(`Audio downloaded in ${elapsed}s`);
				resolve(true);
			});
			cp.on('error', function (error) {
				downloader.system.ffmpeg.status = 'error';
				reject(error);
			});
		});
	}

	private transcribe_audio(live = false): Promise<Boolean> {
		const downloader = this;
		downloader.system.whisper.status = 'in-progress';
		downloader.logger.info('Transcribing audio...');
		downloader.logger.info(downloader.system.whisper.file);
		const time = Date.now();

		return new Promise((resolve, reject) => {
			stat(downloader.system.whisper.file)
				.then((stats) => {
					const cmd = 'whisper';
					const args = [
						downloader.system.whisper.file,
					];
					if (live) {
						args.push('--model', 'base.en');
					} else {
						args.push('--model', 'small.en');
					}

					const spawnOptions: SpawnOptions = {
						cwd: downloader.directory,
						stdio: 'pipe',
						detached: false,
						windowsHide: true,
					};
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const cp = process.platform === 'win32'
						? spawn(process.env.comspec, ['/c', cmd, ...args], spawnOptions)
						: spawn(cmd, args, spawnOptions);

					cp.on('close', function (code) {
						downloader.system.whisper.status = 'complete';
						const elapsed = Math.round((Date.now() - time) / 100) / 10;
						downloader.logger.info(`Audio transcribed in ${elapsed}s`);
						resolve(true);
					});
					cp.on('error', function (error) {
						downloader.system.whisper.status = 'error';
						downloader.logger.error('Failed to transcribe audio ' + error);
						reject(error);
					});
				})
				.catch((error) => {
					downloader.system.whisper.status = 'pending';
					downloader.logger.error('Failed to load audio file ' + error);
					resolve(false);
				});
		});
	};

	private process_captions(live = false): Promise<boolean> {
		const downloader = this;
		downloader.system.captions.status = 'in-progress';
		downloader.logger.info('Processing captions...');
		downloader.logger.info(downloader.system.captions.file);
		const time = Date.now();
		const ms_space_elapsed = ((live) && (downloader.timeStarted > 0)) ? (time - downloader.timeStarted) : 0;

		return new Promise((resolve, reject) => {
			const phrases: CaptionPhrase[] = [];
			let phrases_matched = 0;
			let phrases_scanned = 0;
			let ms_phrase_last = 0;

			stat(downloader.system.captions.file)
				.then((stats) => {
					createReadStream(downloader.system.captions.file)
					.pipe(parse())
					.on('data', function (node) {
						if (node.type === 'cue') {
							// remove non-text characters
							let text = node.data.text.replace(/[.,#!\^;:{}=_`~()]/g, '');
							// search captions and bold+underline detected phrases
							keywords.forEach((keyword) => {
								if (keyword.regexp.test(text)) {
									text = text.replaceAll(keyword.regexp, '__**' + keyword.format + '**__');
									phrases_matched++;
								}
							});
							phrases.push(new CaptionPhrase(node.data.start + ms_space_elapsed, text));
							// get the last phrase end time
							if (node.data.end > ms_phrase_last) {
								ms_phrase_last = node.data.end;
							}
							phrases_scanned++;
						}
					})
					.on('finish', function () {
						downloader.system.captions.status = 'complete';
						if (phrases_matched >= 1) {
							downloader.system.phrases = phrases;
						}
						const elapsed = Math.round((Date.now() - time) / 100) / 10;
						downloader.logger.debug(`Captions scanned in ${elapsed}s [${phrases_scanned} phrases/${Math.round(ms_phrase_last/100)/10}s}]`);
						resolve(true);
					})
					.on('error', function(error) {
						downloader.system.captions.status = 'error';
						downloader.logger.error('Failed to process captions ' + error);
						reject(error);
					});
				})
				.catch((error) => {
					downloader.system.captions.status = 'pending';
					downloader.logger.error('Failed to load captions file ' + error);
					resolve(false);
				});
		});
	};
};