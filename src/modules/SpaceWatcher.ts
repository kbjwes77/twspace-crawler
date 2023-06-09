import axios from 'axios';
import { program } from 'commander';
import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import open from 'open';
import winston from 'winston';
import { PeriscopeApi } from '../apis/PeriscopeApi';
import { TwitterApi } from '../apis/TwitterApi';
import { APP_PLAYLIST_CHUNK_VERIFY_MAX_RETRY, APP_PLAYLIST_REFRESH_INTERVAL, APP_SPACE_ERROR_RETRY_INTERVAL } from '../constants/app.constant';
import { TWITTER_AUTHORIZATION } from '../constants/twitter.constant';
import { AudioSpaceMetadataState } from '../enums/Twitter.enum';
import { AccessChat } from '../interfaces/Periscope.interface';
import { AudioSpace, AudioSpaceMetadata, LiveVideoStreamStatus, CaptionPhrase } from '../interfaces/Twitter.interface';
import { logger as baseLogger, spaceLogger } from '../logger';
import { PeriscopeUtil } from '../utils/PeriscopeUtil';
import { SpaceUtil } from '../utils/SpaceUtil';
import { TwitterUtil } from '../utils/TwitterUtil';
import { Util } from '../utils/Util';
import { configManager } from './ConfigManager';
import { Notification } from './Notification';
import { SpaceDownloader } from './SpaceDownloader';
import { Webhook } from './Webhook';
import { DateTime } from 'luxon';

export class SpaceWatcher extends EventEmitter {
    private logger: winston.Logger;
    private downloader: SpaceDownloader;
    private audioSpace: AudioSpace;
    private liveStreamStatus: LiveVideoStreamStatus;
    private accessChatData: AccessChat;
    private dynamicPlaylistUrl: string;
    private lastChunkIndex: number;
    private chunkVerifyCount = 0;
    private isNotificationNotified = false;

    constructor(public spaceId: string) {
        super();
        this.logger = baseLogger.child({ label: `[SpaceWatcher@${spaceId}]` });

        // Force open space url in browser (no need to wait for notification)
        if (program.getOptionValue('forceOpen')) {
        open(this.spaceUrl);
        }
    };

    public get spaceUrl(): string {
        return TwitterUtil.getSpaceUrl(this.spaceId);
    };

    public get metadata(): AudioSpaceMetadata {
        return this.audioSpace?.metadata;
    };

    public get spaceTitle(): string {
        return SpaceUtil.getTitle(this.audioSpace);
    };

    public get userScreenName(): string {
        return SpaceUtil.getHostUsername(this.audioSpace);
    };

    public get userDisplayName(): string {
        return SpaceUtil.getHostName(this.audioSpace);
    };

    private get detected_phrases(): CaptionPhrase[] {
        return this.audioSpace.detected_phrases;
    };

    private set detected_phrases(phrases: CaptionPhrase[]) {
        this.audioSpace.detected_phrases = phrases;
    };

    private get filename(): string {
        const date = DateTime.fromMillis(this.metadata.started_at || this.metadata.created_at);
        return Util.getCleanFileName(this.userScreenName) + '-' + date.toFormat('MM-dd-yyyy') + '-' + this.spaceId;
    };

    public async watch(): Promise<void> {
        this.logger.info('Watching...');
        this.logger.info(`Space url: ${this.spaceUrl}`);
        try {
            await this.initData();
        } catch (error) {
            if (this.metadata) {
                this.logger.error(`watch: ${error.message}`);
            }
            const ms = APP_SPACE_ERROR_RETRY_INTERVAL;
            this.logger.info(`Retry watch in ${ms}ms`);
            setTimeout(() => this.watch(), ms);
        }
    };

    // eslint-disable-next-line class-methods-use-this
    private async getHeaders() {
        const guestToken = await configManager.getGuestToken();
        const headers = {
            authorization: TWITTER_AUTHORIZATION,
            'x-guest-token': guestToken,
        };
        return headers;
    };

    private async getSpaceMetadata() {
        const headers = await this.getHeaders();
        const requestId = randomUUID();
        try {
            this.logger.debug('--> getSpaceMetadata', { requestId });
            const response = await TwitterApi.getAudioSpaceById(this.spaceId, headers);
            this.logger.debug('<-- getSpaceMetadata', { requestId });
            const audioSpace = response?.data?.audioSpace as AudioSpace;
            delete audioSpace.sharings;
            const metadata = audioSpace?.metadata;
            //this.logger.info('Space metadata', metadata)
            if (!metadata?.creator_results?.result?.rest_id) {
                delete metadata.creator_results;
            }
            this.audioSpace = audioSpace;
            //this.logger.info('Host info', { screenName: this.userScreenName, displayName: this.userDisplayName });
        } catch (error) {
            const meta = { requestId };
            if (error.response) {
                Object.assign(meta, {
                    response: {
                        status: error.response.status,
                        data: error.response.data,
                    },
                });
            }
            this.logger.error(`getSpaceMetadata: ${error.message}`, meta);

            // Bad guest token
            if (error.response?.data?.errors?.some?.((v) => v.code === 239)) {
                configManager.getGuestToken(true)
                .then(() => this.logger.debug('getSpaceMetadata: refresh guest token success'))
                .catch(() => this.logger.error('getSpaceMetadata: refresh guest token failed'));
            }
            throw error;
        }
    };

    private async initData() {
        if (!this.metadata) {
            await this.getSpaceMetadata();
            if (this.metadata.state === AudioSpaceMetadataState.RUNNING) {
                this.showNotification();
            }
        }

        // download space by url
        this.dynamicPlaylistUrl = program.getOptionValue('url');
        if (this.dynamicPlaylistUrl) {
            return this.downloadAudio();
        }

        if (!this.liveStreamStatus) {
            const requestId = randomUUID();
            const headers = await this.getHeaders();
            this.logger.debug('--> getLiveVideoStreamStatus', { requestId });
            this.liveStreamStatus = await TwitterApi.getLiveVideoStreamStatus(this.metadata.media_key, headers);
            this.logger.debug('<-- getLiveVideoStreamStatus', { requestId });
            this.logger.debug('liveStreamStatus', this.liveStreamStatus);
        }

        if (!this.dynamicPlaylistUrl) {
            this.dynamicPlaylistUrl = this.liveStreamStatus.source.location;
            //this.logger.debug('dynamicPlaylistUrl', tthis.dynamicPlaylistUrl);
            this.logger.debug('Sending webhooks for new dynamic playlist url');
            this.sendWebhooks(false);
        }

        if (!this.accessChatData) {
            const requestId = randomUUID();
            this.logger.debug('--> getAccessChat', { requestId });
            this.accessChatData = await PeriscopeApi.getAccessChat(this.liveStreamStatus.chatToken);
            this.logger.debug('<-- getAccessChat', { requestId });
            //this.logger.debug('accessChat data', this.accessChatData);
            //this.logger.info(`Chat endpoint: ${this.accessChatData.endpoint}`);
            //this.logger.info(`Chat access token: ${this.accessChatData.access_token}`);
        }

        // download space
        if (this.metadata.state === AudioSpaceMetadataState.ENDED) {
            return this.processDownload();
        }

        // force download space
        if (program.getOptionValue('force')) {
            return this.downloadAudio();
        }

        this.checkDynamicPlaylist();
    };

    private logSpaceInfo() {
        const payload = {
            username: this.userScreenName,
            id: this.spaceId,
            started_at: this.metadata.started_at,
            title: this.spaceTitle || null,
            playlist_url: PeriscopeUtil.getMasterPlaylistUrl(this.dynamicPlaylistUrl),
        };
        spaceLogger.info(payload);
        this.logger.info('Space info', payload);
    };

    private logSpaceAudioDuration() {
        if (!this.metadata.ended_at || !this.metadata.started_at) {
            return;
        }
        const ms = Number(this.metadata.ended_at) - this.metadata.started_at;
        const duration = Util.getDisplayTime(ms);
        this.logger.info(`Expected audio duration: ${duration}`);
    }

    private async checkDynamicPlaylist(): Promise<void> {
        const requestId = randomUUID();
        this.logger.debug('--> checkDynamicPlaylist', { requestId });
        try {
            const { data } = await axios.get<string>(this.dynamicPlaylistUrl);
            this.logger.debug('<-- checkDynamicPlaylist', { requestId });
            //this.logger.debug('Dynamic playlist url: ' + this.dynamicPlaylistUrl);
            const chunkIndexes = PeriscopeUtil.getChunks(data);
            if (chunkIndexes.length) {
                //this.logger.debug(`Found chunks: ${chunkIndexes.join(',')}`);
                this.lastChunkIndex = Math.max(...chunkIndexes);
                if (this.lastChunkIndex >= 1) {
                    await this.processLiveDownload();
                }
            }
        } catch (error) {
            const status = error.response?.status;
            if (status === 404) {
                // Space ended / Host disconnected
                this.logger.info(`Dynamic playlist status: ${status}`);
                this.checkMasterPlaylist();
                return;
            }
            this.logger.error(`checkDynamicPlaylist: ${error.message}`, { requestId });
        }
        this.checkDynamicPlaylistWithTimer();
    };

    private async checkMasterPlaylist(): Promise<void> {
        this.logger.debug('--> checkMasterPlaylist')
        try {
            const masterChunkSize = PeriscopeUtil.getChunks(await PeriscopeApi.getFinalPlaylist(this.dynamicPlaylistUrl)).length
            this.logger.debug(`<-- checkMasterPlaylist: master chunk size ${masterChunkSize}, last chunk index ${this.lastChunkIndex}`)
            const canDownload = !this.lastChunkIndex
                || this.chunkVerifyCount > APP_PLAYLIST_CHUNK_VERIFY_MAX_RETRY
                || masterChunkSize >= this.lastChunkIndex;
            if (canDownload) {
                await this.processDownload();
                return;
            }
            this.logger.warn(`Master chunk size (${masterChunkSize}) lower than last chunk index (${this.lastChunkIndex})`);
            this.chunkVerifyCount++;
        } catch (error) {
            this.logger.error(`checkMasterPlaylist: ${error.message}`);
        }
        this.checkMasterPlaylistWithTimer();
    };

    private checkDynamicPlaylistWithTimer(ms = APP_PLAYLIST_REFRESH_INTERVAL) {
        setTimeout(() => this.checkDynamicPlaylist(), ms);
    };

    private checkMasterPlaylistWithTimer(ms = APP_PLAYLIST_REFRESH_INTERVAL) {
        this.logger.info(`Recheck master playlist in ${ms}ms`);
        setTimeout(() => this.checkMasterPlaylist(), ms);
    };

    private async processDownload() {
        //this.logger.debug('processDownload');
        try {
            // Get latest metadata in case title changed
            await this.getSpaceMetadata();
            this.logSpaceInfo();

            if (this.metadata.state === AudioSpaceMetadataState.RUNNING) {
                // Recheck dynamic playlist in case host disconnect for a long time
                return this.checkDynamicPlaylistWithTimer();
            }

            // download space audio
            await this.downloadAudio(false);
        } catch (error) {
            this.logger.warn(`processDownload: ${error.message}`);
        }
    };

    private async processLiveDownload() {
        //this.logger.debug('processLiveDownload');
        try {
            // Get latest metadata in case title changed
            await this.getSpaceMetadata();
            this.logSpaceInfo();

            if (this.metadata.state === AudioSpaceMetadataState.RUNNING) {
                await this.downloadAudio(true);
            }
        } catch (error) {
            this.logger.warn(`processLiveDownload: ${error.message}`);
        }
    };

    private downloadAudio(live=false) {
        const watcher = this;
        const metadata = {
            title: watcher.spaceTitle,
            author: watcher.userDisplayName,
            artist: watcher.userDisplayName,
            episode_id: watcher.spaceId
        };
        //watcher.logger.info(`File name: ${watcher.filename}`)
        //watcher.logger.info(`File metadata: ${JSON.stringify(metadata)}`)

        if ((!watcher.downloader) || (!live)) {
            watcher.downloader = new SpaceDownloader(
                watcher.dynamicPlaylistUrl,
                watcher.filename + ((live) ? '-live' : ''),
                watcher.userScreenName,
                watcher.metadata.started_at || watcher.metadata.created_at,
                metadata
            );
            // attempt to download audio
            return watcher.downloader.download(live)
                .then((success) => {
                    if (success) {
                        if (watcher.downloader) {
                            watcher.logger.debug('Downloaded audio successfully, found ' + watcher.downloader.system.phrases.length + ' phrases');
                            if (watcher.downloader.system.phrases.length >= 1) {
                                watcher.detected_phrases = watcher.downloader.system.phrases;
                                return watcher.sendWebhooks(true);
                            }
                        }
                    }
                    watcher.downloader = undefined;
                    delete watcher.downloader;
                    return [false, false];
                });
        }
    };

    private async showNotification() {
        if (!program.getOptionValue('notification') || this.isNotificationNotified) {
            return;
        }
        this.isNotificationNotified = true;
        const notification = new Notification({
                title: `${this.userDisplayName || ''} Space Live!`.trim(),
                message: `${this.spaceTitle || ''}`,
                icon: SpaceUtil.getHostProfileImgUrl(this.audioSpace),
            },
            this.spaceUrl,
        );
        notification.notify();
    };

    private sendWebhooks(live=false) {
        const webhook = new Webhook(
            this.audioSpace,
            PeriscopeUtil.getMasterPlaylistUrl(this.dynamicPlaylistUrl),
            this.filename + ((live) ? '-live' : ''),
            this.userScreenName
        );
        return webhook.send();
    };
};
