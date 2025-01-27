/* global fisher */

import ID3Writer from 'browser-id3-writer';

const downloader = {
    TYPE: Object.freeze({
        TRACK: 'track',
        ALBUM: 'album',
        PLAYLIST: 'playlist',
        COVER: 'cover'
    }),
    STATUS: Object.freeze({
        WAITING: 'waiting',
        LOADING: 'loading',
        FINISHED: 'finished',
        INTERRUPTED: 'interrupted'
    }),
    PATH_LIMIT: 50,
    downloads: new Map(),
    downloadsLastIndex: 0,
    activeThreadCount: 0,
    minBitrate: 192 * 1000 / 8, // кбиты -> байты
    maxBitrate: 320 * 1000 / 8
};

downloader.runAllThreads = () => {
    for (let i = 0; i < fisher.storage.getItem('downloadThreadCount'); i++) {
        downloader.download();
    }
};

downloader.download = async () => {
    fisher.utils.updateBadge();
    if (downloader.activeThreadCount < 0) {
        downloader.activeThreadCount = 0; // выравнивание при сбоях
    }
    if (downloader.activeThreadCount >= fisher.storage.getItem('downloadThreadCount')) {
        return; // достигнуто максимальное количество потоков загрузки
    }
    const entity = downloader.getWaitingEntity();

    if (!entity) { // в очереди нет загрузок
        return;
    }
    entity.status = downloader.STATUS.LOADING;
    downloader.activeThreadCount++;
    let coverBuffer;
    let trackAlbum;

    function onInterruptEntity(error) {
        entity.loadedBytes = 0;
        entity.status = downloader.STATUS.INTERRUPTED;
        console.error(error, entity);
        downloader.activeThreadCount--;
        downloader.download();
    }

    function onProgress(event) {
        entity.loadedBytes = event.loaded;
    }

    function onChromeDownloadStart(downloadId) {
        if (chrome.runtime.lastError) {
            onInterruptEntity(chrome.runtime.lastError.message);
        } else {
            if (PLATFORM_CHROME) {
                chrome.downloads.setShelfEnabled(false);
            }
            entity.browserDownloadId = downloadId;
        }
    }

    function saveTrack(buffer, codec) {
        if (!downloader.downloads.has(entity.index)) { // загрузку отменили
            return;
        }
        const writer = new ID3Writer(buffer);
        const artists = fisher.utils.parseArtists(entity.track.artists);

        if (trackAlbum) {
            if ('artists' in trackAlbum && Array.isArray(trackAlbum.artists)) {
                writer.setFrame('TPE2', fisher.utils.parseArtists(trackAlbum.artists).artists.join(', '));
            }
            if ('genre' in trackAlbum && typeof trackAlbum.genre === 'string') {
                writer.setFrame('TCON', [trackAlbum.genre[0].toUpperCase() + trackAlbum.genre.substr(1)]);
            }
            if ('title' in trackAlbum) {
                writer.setFrame('TALB', trackAlbum.title);
            }
            if ('year' in trackAlbum) {
                writer.setFrame('TYER', trackAlbum.year);
            }
            if ('labels' in trackAlbum && Array.isArray(trackAlbum.labels) && trackAlbum.labels.length) {
                writer.setFrame('TPUB', trackAlbum.labels.map((label) => label.name).join(', '));
            }
            if ('trackPosition' in entity && 'trackCountInAlbum' in entity) {
                writer.setFrame('TRCK', `${entity.trackPosition}/${entity.trackCountInAlbum}`);
            }
            if ('albumPosition' in entity && 'albumCount' in entity) {
                writer.setFrame('TPOS', `${entity.albumPosition}/${entity.albumCount}`);
            }
        }

        if ('title' in entity) {
            writer.setFrame('TIT2', entity.title);
        }
        if (artists.artists.length > 0) {
            writer.setFrame('TPE1', artists.artists);
        }
        if ('durationMs' in entity.track) {
            writer.setFrame('TLEN', entity.track.durationMs);
        }
        if (artists.composers.length > 0) {
            writer.setFrame('TCOM', artists.composers);
        }
        if ('lyrics' in entity && typeof entity.lyrics === 'string') {
            writer.setFrame('USLT', {
                description: '',
                lyrics: entity.lyrics
            });
        }
        if (coverBuffer) {
            try {
                writer.setFrame('APIC', {
                    type: 3,
                    data: coverBuffer,
                    description: ''
                });
            } catch (e) {
                // пример https://music.yandex.ru/album/99853/track/879704 при обложке 200х200
                console.error(e, entity);
            }
        }
        writer.addTag();

        let savePath = entity.savePath;
        if (fisher.storage.getItem('shouldUseFolder')) {
            savePath = `${fisher.storage.getItem('folder')}/${savePath}`;
        }

        if (codec === 'mp3') {
            entity.browserDownloadUrl = writer.getURL();
            savePath += '.mp3';
        } else if (codec === 'aac') {
            entity.browserDownloadUrl = window.URL.createObjectURL(new Blob([buffer]));
            savePath += '.m4a';
        }
        chrome.downloads.download({
            url: entity.browserDownloadUrl,
            filename: savePath,
            conflictAction: 'overwrite',
            saveAs: !fisher.storage.getItem('dontAskDownload')
        }, onChromeDownloadStart);
    }

    if (entity.type === downloader.TYPE.TRACK) {
        if ('albums' in entity.track && entity.track.albums.length > 0) {
            // у треков из яндекс.диска может не быть альбома
            trackAlbum = entity.track.albums[0];
        }
        if (trackAlbum && 'coverUri' in trackAlbum) {
            // пример альбома без обложки: https://music.yandex.ru/album/2236232/track/23652415
            const coverUrl = `https://${trackAlbum.coverUri.replace('%%', fisher.storage.getItem('albumCoverSizeId3'))}`;

            try {
                coverBuffer = await fisher.utils.fetchBuffer(coverUrl);
            } catch (e) {
                if (e.message !== '404 (Not found)') {
                    onInterruptEntity(e.message);
                    return;
                }
            }
        }
        try {
            const downloadInfo = await fisher.yandex.getTrackDownloadInfo(entity.track.id);
            const buffer = await fisher.utils.fetchBuffer(downloadInfo.url, onProgress);

            saveTrack(buffer, downloadInfo.codec);
        } catch (e) {
            onInterruptEntity(e.message);
        }
    } else if (entity.type === downloader.TYPE.COVER) {
        let buffer;

        try {
            buffer = await fisher.utils.fetchBuffer(entity.url, onProgress);
        } catch (e) {
            if (e.message !== '404 (Not found)') {
                onInterruptEntity(e.message);
                return;
            }
        }
        if (!downloader.downloads.has(entity.index)) { // загрузку отменили
            return;
        }

        const blob = new Blob([buffer], {type: 'image/jpeg'});
        entity.browserDownloadUrl = window.URL.createObjectURL(blob);

        let savePath = entity.savePath;
        if (fisher.storage.getItem('shouldUseFolder')) {
            savePath = `${fisher.storage.getItem('folder')}/${savePath}`;
        }

        chrome.downloads.download({
            url: entity.browserDownloadUrl,
            filename: savePath,
            conflictAction: 'overwrite',
            saveAs: !fisher.storage.getItem('dontAskDownload')
        }, onChromeDownloadStart);
    }
};

downloader.downloadTrack = (trackId, albumId, folder) => {
    fisher.yandex.getTrack(trackId, albumId).then(json => {
        const track = json.track;

        if ('error' in track) {
            console.error(`Track error: ${track.error}`, track);
            return;
        }
        const trackEntity = {
            type: downloader.TYPE.TRACK,
            status: downloader.STATUS.WAITING,
            index: downloader.downloadsLastIndex++,
            track,
            artists: fisher.utils.parseArtists(track.artists).artists.join(', '),
            title: track.title,
            savePath: '',
            lyrics: null,
            loadedBytes: 0,
            browserDownloadId: null,
            browserDownloadUrl: null
        };

        if ('version' in track) {
            trackEntity.title += ` (${track.version})`;
        }
        if (json.lyric.length && json.lyric[0].fullLyrics) {
            trackEntity.lyrics = json.lyric[0].fullLyrics;
        }
        const shortArtists = trackEntity.artists.substr(0, downloader.PATH_LIMIT);
        const shortTitle = trackEntity.title.substr(0, downloader.PATH_LIMIT);

        if (folder) {
            const shortFolder = folder.substr(0, downloader.PATH_LIMIT);
            trackEntity.savePath = `${fisher.utils.clearPath(shortFolder, true)}/`;
        }

        trackEntity.savePath += fisher.utils.clearPath(`${shortArtists} - ${shortTitle}`);
        downloader.downloads.set(trackEntity.index, trackEntity);
        downloader.download();
    }).catch((e) => console.error(e));
};

downloader.downloadAlbum = (albumId, folder) => {
    fisher.yandex.getAlbum(albumId).then(album => {
        if (!album.trackCount) {
            return;
        }
        const albumEntity = {
            type: downloader.TYPE.ALBUM,
            index: downloader.downloadsLastIndex++,
            artists: fisher.utils.parseArtists(album.artists).artists.join(', '),
            title: album.title,
            tracks: [],
            cover: null
        };

        if ('version' in album) {
            albumEntity.title += ` (${album.version})`;
        }
        let saveDir = '';

        if (folder) {
            const shortFolder = folder.substr(0, downloader.PATH_LIMIT);
            saveDir += `${fisher.utils.clearPath(shortFolder, true)}/`;
        }
        const shortAlbumArtists = albumEntity.artists.substr(0, downloader.PATH_LIMIT);
        const shortAlbumTitle = albumEntity.title.substr(0, downloader.PATH_LIMIT);

        if ('year' in album) {
            saveDir += fisher.utils.clearPath(`${album.year} - ${shortAlbumArtists} - ${shortAlbumTitle}`, true);
        } else {
            saveDir += fisher.utils.clearPath(`${shortAlbumArtists} - ${shortAlbumTitle}`, true);
        }

        if (fisher.storage.getItem('shouldDownloadCover') && 'coverUri' in album) {
            albumEntity.cover = {
                type: downloader.TYPE.COVER,
                index: albumEntity.index,
                status: downloader.STATUS.WAITING,
                url: `https://${album.coverUri.replace('%%', fisher.storage.getItem('albumCoverSize'))}`,
                savePath: `${saveDir}/cover.jpg`,
                loadedBytes: 0,
                browserDownloadId: null,
                browserDownloadUrl: null
            };
        }

        album.volumes.forEach((volume, i) => {
            const trackNameCounter = {}; // пример: https://music.yandex.ru/album/512639

            volume.forEach((track, j) => {
                if ('error' in track) {
                    console.error(`Track error: ${track.error}`, track);
                    return;
                }
                const trackPosition = j + 1;
                const albumPosition = i + 1;
                const trackEntity = {
                    type: downloader.TYPE.TRACK,
                    index: albumEntity.index,
                    status: downloader.STATUS.WAITING,
                    track,
                    artists: fisher.utils.parseArtists(track.artists).artists.join(', '),
                    title: track.title,
                    savePath: null,
                    loadedBytes: 0,
                    trackPosition,
                    trackCountInAlbum: volume.length,
                    albumPosition,
                    albumCount: album.volumes.length,
                    browserDownloadId: null,
                    browserDownloadUrl: null
                };

                if ('version' in track) {
                    trackEntity.title += ` (${track.version})`;
                }

                let shortTrackTitle = trackEntity.title.substr(0, downloader.PATH_LIMIT);
                let savePath = `${saveDir}/`;

                if (album.volumes.length > 1) {
                    // пример: https://music.yandex.ru/album/2490723
                    savePath += `CD${albumPosition}/`;
                }

                if (fisher.storage.getItem('enumerateAlbums')) {
                    // нумеруем все треки
                    savePath += `${fisher.utils.addExtraZeros(trackPosition, volume.length)}. `;
                } else if (shortTrackTitle in trackNameCounter) {
                    // если совпадают имена - добавляем номер
                    trackNameCounter[shortTrackTitle]++;
                    shortTrackTitle += ` (${trackNameCounter[shortTrackTitle]})`;
                } else {
                    trackNameCounter[shortTrackTitle] = 1;
                }

                trackEntity.savePath = savePath + fisher.utils.clearPath(`${shortTrackTitle}`);
                albumEntity.tracks.push(trackEntity);
            });
        });

        if (!albumEntity.tracks.length) {
            return;
        }

        downloader.downloads.set(albumEntity.index, albumEntity);
        downloader.runAllThreads();
    }).catch(e => console.error(e));
};

downloader.downloadPlaylist = (username, playlistId, selectedTracks) => {
    fisher.yandex.getPlaylist(username, playlistId).then(playlist => {
        if (!playlist.trackCount) {
            return;
        }
        const playlistEntity = {
            type: downloader.TYPE.PLAYLIST,
            index: downloader.downloadsLastIndex++,
            title: playlist.title,
            tracks: []
        };
        const shortPlaylistTitle = playlist.title.substr(0, downloader.PATH_LIMIT);
        const saveDir = fisher.utils.clearPath(shortPlaylistTitle, true);
        const trackNameCounter = {}; // пример https://music.yandex.ru/users/dimzon541/playlists/1002

        playlist.tracks.forEach((track, i) => {
            if ('error' in track) {
                console.error(`Track error: ${track.error}`, track);
                return;
            }
            if (selectedTracks != null && !selectedTracks.includes(track.id)) {
                return;
            }
            const trackEntity = {
                type: downloader.TYPE.TRACK,
                index: playlistEntity.index,
                status: downloader.STATUS.WAITING,
                track,
                artists: fisher.utils.parseArtists(track.artists).artists.join(', '),
                title: track.title,
                savePath: null,
                loadedBytes: 0,
                browserDownloadId: null,
                browserDownloadUrl: null
            };

            if ('version' in track) {
                trackEntity.title += ` (${track.version})`;
            }
            const shortTrackArtists = trackEntity.artists.substr(0, downloader.PATH_LIMIT);
            const shortTrackTitle = trackEntity.title.substr(0, downloader.PATH_LIMIT);

            let name = `${shortTrackArtists} - ${shortTrackTitle}`;
            let savePath = `${saveDir}/`;

            if (fisher.storage.getItem('enumeratePlaylists')) {
                // нумеруем все треки
                savePath += `${fisher.utils.addExtraZeros(i + 1, playlist.tracks.length)}. `;
            } else if (name in trackNameCounter) {
                // если совпадают имена - добавляем номер
                trackNameCounter[name]++;
                name += ` (${trackNameCounter[name]})`;
            } else {
                trackNameCounter[name] = 1;
            }

            trackEntity.savePath = savePath + fisher.utils.clearPath(`${name}`);
            playlistEntity.tracks.push(trackEntity);
        });

        if (!playlistEntity.tracks.length) {
            return;
        }

        downloader.downloads.set(playlistEntity.index, playlistEntity);
        downloader.runAllThreads();
    }).catch(e => console.error(e));
};

downloader.getWaitingEntity = () => {
    let foundEntity;

    downloader.downloads.forEach(entity => {
        if (foundEntity) {
            return;
        }
        const isAlbum = entity.type === downloader.TYPE.ALBUM;
        const isCover = isAlbum && entity.cover;
        const isPlaylist = entity.type === downloader.TYPE.PLAYLIST;
        const isTrack = entity.type === downloader.TYPE.TRACK;

        if (isCover && entity.cover.status === downloader.STATUS.WAITING) {
            foundEntity = entity.cover;
        } else if (isAlbum || isPlaylist) {
            entity.tracks.forEach((track) => {
                if (foundEntity) {
                    return;
                }
                if (track.status === downloader.STATUS.WAITING) {
                    foundEntity = track;
                }
            });
        } else if (isTrack) {
            if (entity.status === downloader.STATUS.WAITING) {
                foundEntity = entity;
            }
        }
    });
    return foundEntity;
};

downloader.getDownloadCount = () => {
    let count = 0;

    downloader.downloads.forEach(entity => {
        const isAlbum = entity.type === downloader.TYPE.ALBUM;
        const isCover = isAlbum && entity.cover;
        const isPlaylist = entity.type === downloader.TYPE.PLAYLIST;
        const isTrack = entity.type === downloader.TYPE.TRACK;

        if (isCover && entity.cover.status !== downloader.STATUS.FINISHED) {
            count++;
        }
        if (isAlbum || isPlaylist) {
            entity.tracks.forEach((track) => {
                if (track.status !== downloader.STATUS.FINISHED) {
                    count++;
                }
            });
        } else if (isTrack && entity.status !== downloader.STATUS.FINISHED) {
            count++;
        }
    });
    return count;
};

downloader.getEntityByBrowserDownloadId = (browserDownloadId) => {
    let foundEntity;

    downloader.downloads.forEach(entity => {
        if (foundEntity) {
            return;
        }
        const isAlbum = entity.type === downloader.TYPE.ALBUM;
        const isCover = isAlbum && entity.cover;
        const isPlaylist = entity.type === downloader.TYPE.PLAYLIST;
        const isTrack = entity.type === downloader.TYPE.TRACK;

        if (isCover && entity.cover.browserDownloadId === browserDownloadId) {
            foundEntity = entity.cover;
        } else if (isAlbum || isPlaylist) {
            entity.tracks.forEach((track) => {
                if (foundEntity) {
                    return;
                }
                if (track.browserDownloadId === browserDownloadId) {
                    foundEntity = track;
                }
            });
        } else if (isTrack) {
            if (entity.browserDownloadId === browserDownloadId) {
                foundEntity = entity;
            }
        }
    });
    return foundEntity;
};

export default downloader;
