import axios from 'axios'
import { spawn, SpawnOptions } from 'child_process'
import { writeFileSync, createReadStream } from 'fs'
import { parse } from 'subtitle'
import path from 'path'
import winston from 'winston'
import { PeriscopeApi } from '../apis/PeriscopeApi'
import { logger as baseLogger } from '../logger'
import { PeriscopeUtil } from '../utils/PeriscopeUtil'
import { Util } from '../utils/Util'
import { CaptionPhrase } from '../interfaces/Twitter.interface'

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
      'groiper',
      'grouper',
      'gripper',
      'graper',
      'griper'
    ],
    fmt: 'groyper'
  },
  {
    raw: [
      'groyp',
      'groip'
    ],
    fmt: 'groyp'
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
    this.logger = baseLogger.child({ label: '[SpaceDownloader]' })
    this.directory = Util.getMediaDir(subDir);
    this.playlistFile = path.join(this.directory, `${filename}.m3u8`)
    this.audioFile = path.join(this.directory, `${filename}.mp3`)
    this.subsFile = path.join(this.directory, `${filename}.mp3.vtt`);
    this.timeStarted = started_at;
    this.logger.verbose(`Playlist path: "${this.playlistFile}"`)
    this.logger.verbose(`Audio path: "${this.audioFile}"`)
  }

  public async download(live=false) {
    this.logger.debug('download', { playlistUrl: this.playlistUrl, originUrl: this.originUrl })
    if (live) {
      this.playlistUrl = this.originUrl
    } else if (!this.playlistUrl) {
      this.playlistUrl = await PeriscopeApi.getFinalPlaylistUrl(this.originUrl)
      this.logger.info(`Final playlist url: ${this.playlistUrl}`)
    }

    // Util.createMediaDir(this.subDir)
    // await this.saveFinalPlaylist()
    Util.createMediaDir(this.subDir)
    await this.spawnFfmpeg();
    await this.spawnWhisper(live);
    return await this.processCaptions();
  }

  /*
  private async saveFinalPlaylist() {
    try {
      this.logger.debug(`--> saveFinalPlaylist: ${this.playlistUrl}`)
      const { data } = await axios.get<string>(this.playlistUrl)
      this.logger.debug(`<-- saveFinalPlaylist: ${this.playlistUrl}`)
      const prefix = PeriscopeUtil.getChunkPrefix(this.playlistUrl)
      this.logger.debug(`Chunk prefix: ${prefix}`)
      const newData = data.replace(/^chunk/gm, `${prefix}chunk`)
      writeFileSync(this.playlistFile, newData)
      this.logger.verbose(`Playlist saved to "${this.playlistFile}"`)
    } catch (error) {
      this.logger.debug(`saveFinalPlaylist: ${error.message}`)
      const status = error.response?.status
      if (status === 404 && this.originUrl !== this.playlistUrl) {
        this.playlistUrl = null
      }
      throw error
    }
  }
  */

  private spawnFfmpeg() {
    const time = Date.now();

    const cmd = 'ffmpeg'
    const args = [
      '-t',
      '30',
      '-protocol_whitelist',
      'file,https,tls,tcp',
      '-i',
      // this.playlistFile,
      this.playlistUrl
    ]
    if (this.metadata) {
      Object.keys(this.metadata).forEach((key) => {
        const value = this.metadata[key]
        if (!value) {
          return
        }
        args.push('-metadata', `${key}=${value}`)
      })
    }
    args.push(this.audioFile)
    this.logger.verbose('Spawning FFMPEG to download audio...');
    this.logger.verbose(`${cmd} ${args.join(' ')}`)

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
      : spawn(cmd, args, spawnOptions)
    // cp.unref()

    const logger = this.logger;
    return new Promise((resolve, reject) => {
      cp.on('close', function(code) {
        const elapsed = Math.round(((Date.now() - time) / (1000 * 60))*10)/10;
        logger.info(`Audio downloaded, FFMPEG exited after ${elapsed} minutes`);
        resolve(true);
      });
      cp.on('error', function(error) {
        reject(error);
      });
    });
  }

  private spawnWhisper(live=false) {
    const time = Date.now();
    const logger = this.logger;
    return new Promise((resolve, reject) => {
      const cmd = 'whisper';
      const args = [
        this.audioFile
      ];
      if (live) {
        args.push('--model', 'tiny.en');
      } else {
        args.push('--model', 'small.en');
      }

      logger.debug('Spawning Whisper to transcribe audio...');
      logger.debug(`${cmd} ${args.join(' ')}`);

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

      let time_data = Date.now();
      cp.stdout.on('data', function(data) {
        const elapsed = Math.round(((Date.now() - time_data) / 1000)*10)/10;
        logger.debug(`Audio data transcribed in ${elapsed} seconds`);
        time_data = Date.now();
      });
      cp.on('close', function(code) {
        const elapsed = Math.round(((Date.now() - time) / (1000 * 60))*10)/10;
        logger.info(`Audio transcribed, Whisper exited after ${elapsed} minutes`);
        resolve(true);
      });
      cp.on('error', function(error) {
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
      logger.debug('Processing captions...');

      let match = false;
      createReadStream(this.subsFile)
        .pipe(parse())
        .on('data', function(node) {
          if (node.type === 'cue') {
            let text = node.data.text.replace(/[.,#!\^;:{}=_`~()]/g, '');
            phrases.forEach((phrase) => {
              if (phrase.regexp.test(text)) {
                text = text.replaceAll(phrase.regexp, phrase.format);
                logger.debug('Detected caption phrase match');
                logger.debug(text);
                match = true;
              }
            });
            caption_phrases.push(new CaptionPhrase(node.data.start + elapsed, text));
          }
        })
        .on('error', reject)
        .on('finish', function() {
          const completed = Math.round(((Date.now() - time) / 1000)*10)/10;
          logger.debug('Captions processed in ' + completed + ' seconds');
          if (match === true) {
            resolve(caption_phrases);
          } else {
            resolve([]);
          }
        });
    });
  };
}