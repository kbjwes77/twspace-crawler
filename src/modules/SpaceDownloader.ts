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
import { DetectedPhrase } from '../interfaces/Twitter.interface'

const phrases = [
  'NJF',
  'N J F',
  'Fuentes',
  'Nick Fuentes',
  'Nicholas Fuentes',
  'Nicholas J Fuentes',
  'AFPAC',
  'AFPAK',
  'F Pack',
  'America First',
  'Groyp',
  'Groyper',
  'Groiper',
  'Grouper',
  'Graper',
  'Griper',
  'Cozy TV',
  'Cozy Dot TV',
  'CozyTV'
].map((phrase) => phrase.toLowerCase());

export class SpaceDownloader {
  private logger: winston.Logger

  private directory: string
  private playlistUrl: string
  private playlistFile: string
  private audioFile: string
  private subsFile: string

  constructor(
    private readonly originUrl: string,
    private readonly filename: string,
    private readonly subDir = '',
    private readonly metadata?: Record<string, any>,
  ) {
    this.logger = baseLogger.child({ label: '[SpaceDownloader]' })
    this.logger.debug('constructor', {
      originUrl, filename, subDir, metadata,
    })
    this.directory = Util.getMediaDir(subDir);
    this.playlistFile = path.join(this.directory, `${filename}.m3u8`)
    this.audioFile = path.join(this.directory, `${filename}.mp3`)
    this.subsFile = path.join(this.directory, `${filename}.mp3.vtt`);
    this.logger.verbose(`Playlist path: "${this.playlistFile}"`)
    this.logger.verbose(`Audio path: "${this.audioFile}"`)
  }

  public async download() {
    this.logger.debug('download', { playlistUrl: this.playlistUrl, originUrl: this.originUrl })
    if (!this.playlistUrl) {
      this.playlistUrl = await PeriscopeApi.getFinalPlaylistUrl(this.originUrl)
      this.logger.info(`Final playlist url: ${this.playlistUrl}`)
    }
    // Util.createMediaDir(this.subDir)
    // await this.saveFinalPlaylist()
    Util.createMediaDir(this.subDir)
    await this.spawnFfmpeg();
    await this.spawnWhisper();
    return await this.processCaptions();
  }

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

  private spawnFfmpeg() {
    const cmd = 'ffmpeg'
    const args = [
      '-protocol_whitelist',
      'file,https,tls,tcp',
      '-i',
      // this.playlistFile,
      this.playlistUrl
    ]
    if (this.metadata) {
      this.logger.debug('Audio metadata', this.metadata)
      Object.keys(this.metadata).forEach((key) => {
        const value = this.metadata[key]
        if (!value) {
          return
        }
        args.push('-metadata', `${key}=${value}`)
      })
    }
    args.push(this.audioFile)
    this.logger.verbose(`Audio is saving to "${this.audioFile}"`)
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
        logger.debug('FFMPEG exited with code: ' + code);
        resolve(true);
      });
      cp.on('error', function(error) {
        reject(error);
      })
    });
  }

  private spawnWhisper() {
    const cmd = 'whisper'
    const args = [
      this.audioFile,
      '--model',
      'small.en'
    ]
    this.logger.verbose(`[SpaceDownloader] Transcribing space "${this.audioFile}"`);
    this.logger.verbose(`${cmd} ${args.join(' ')}`);

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
    
    const logger = this.logger;
    return new Promise((resolve, reject) => {
      cp.stdout.on('data', function(data) {
        logger.debug(`Whisper data: ${data}`);
      });
      cp.on('close', function(code) {
        logger.debug('Whisper exited with code: ' + code);
        resolve(true);
      });
      cp.on('error', function(error) {
        reject(error);
      });
    });
  };

  private processCaptions(): Promise<DetectedPhrase[]> {
    const logger = this.logger;
    return new Promise((resolve, reject) => {

      const matches = [];
      createReadStream(this.subsFile)
        .pipe(parse())
        .on('data', function(node) {
          if (node.type === 'cue') {
            for(let i=0; i<phrases.length; i++) {
              const regex = new RegExp(phrases[i]);
              if (regex.test(node.data.text.toLowerCase().replace(/[^a-z0-9 ]/g, ''))) {
                matches.push(new DetectedPhrase(node.data.start, node.data.text));
                break;
              }
            }
          }
        })
        .on('error', reject)
        .on('finish', function() {
          logger.debug('Captions processed, found ' + matches.length + ' matches');
          resolve(matches);
        });
    });
  };
}