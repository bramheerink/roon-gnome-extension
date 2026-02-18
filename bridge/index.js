import RoonApi from 'node-roon-api';
import RoonApiTransport from 'node-roon-api-transport';
import RoonApiImage from 'node-roon-api-image';
import RoonApiStatus from 'node-roon-api-status';
import RoonApiBrowse from 'node-roon-api-browse';
import dbus from 'dbus-next';
import express from 'express';

const { Interface, property, method, ACCESS_READ, ACCESS_READWRITE } = dbus.interface;
// Patch node-roon-api reconnection bugs (see roonlabs/node-roon-api#40):
// 1. is_paired never set back to true on reconnect → periodic_scan keeps firing
// 2. scan_count never reset → scans only every 60s instead of 10s after disconnect
// 3. periodic_scan throttles after first 6 scans even when unpaired
const SOOD_ID = "00720724-5143-4a9b-abac-0e50cba674bb";
RoonApi.prototype.periodic_scan = function() {
    this.scan_count += 1;
    if (this.is_paired) return;
    if (this._sood) this._sood.query({ query_service_id: SOOD_ID });
};
const _origWsConnect = RoonApi.prototype.ws_connect;
RoonApi.prototype.ws_connect = function(opts) {
    const origOnclose = opts.onclose;
    opts.onclose = () => { this.scan_count = -1; origOnclose?.(); };
    const moo = _origWsConnect.call(this, opts);
    const origOnopen = moo.transport.onopen;
    moo.transport.onopen = () => { this.scan_count = -1; origOnopen.call(moo.transport); };
    return moo;
};

// Normalize Roon volume (number or dB) to 0.0-1.0
function normalizeVolume(vol) {
    if (!vol || vol.value === undefined) return 0;
    const min = vol.hard_limit_min ?? vol.min ?? 0;
    const max = vol.hard_limit_max ?? vol.max ?? 100;
    if (max === min) return 0;
    return (vol.value - min) / (max - min);
}

// Convert 0.0-1.0 back to Roon volume value
function denormalizeVolume(vol, normalized) {
    if (!vol) return 0;
    const min = vol.hard_limit_min ?? vol.min ?? 0;
    const max = vol.hard_limit_max ?? vol.max ?? 100;
    return Math.round(min + normalized * (max - min));
}

class RoonMprisBridge {
    constructor() {
        this.roon = null;
        this.core = null;
        this.transport = null;
        this.image = null;
        this.browse = null;
        this.zones = new Map();
        this.activeZoneId = null;
        this.imageServer = null;
        this.bus = null;

        // MPRIS state
        this._playbackStatus = 'Stopped';
        this._metadata = {};
        this._volume = 0.5;
        this._position = BigInt(0);

        // Waveform data per zone
        this._waveforms = new Map();
    }

    async start() {
        console.log('Starting Roon MPRIS Bridge...');

        // Start image server for album art
        this.startImageServer();

        // Initialize D-Bus and MPRIS
        await this.initDbus();

        // Initialize Roon API
        this.roon = new RoonApi({
            extension_id: 'org.gnome.roon-extension',
            display_name: 'GNOME Integration',
            display_version: '1.0.0',
            publisher: 'Community',
            email: 'noreply@example.com',
            log_level: 'none',
            core_paired: (core) => this.onCorePaired(core),
            core_unpaired: (core) => this.onCoreUnpaired(core)
        });

        this.roon.init_services({
            required_services: [RoonApiTransport, RoonApiImage, RoonApiBrowse],
            provided_services: [
                new RoonApiStatus(this.roon)
            ]
        });

        console.log('Starting Roon discovery...');
        this.roon.start_discovery();
    }

    async initDbus() {
        this.bus = dbus.sessionBus();

        // Request the MPRIS bus name
        await this.bus.requestName('org.mpris.MediaPlayer2.roon', 0);

        // Create custom Roon interfaces
        await this.initRoonZonesInterface();
        await this.initRoonBrowseInterface();

        // Create MediaPlayer2 interface
        const mediaPlayer2Iface = {
            name: 'org.mpris.MediaPlayer2',
            methods: {
                Raise: {},
                Quit: {}
            },
            properties: {
                CanQuit: { signature: 'b', access: ACCESS_READ },
                CanRaise: { signature: 'b', access: ACCESS_READ },
                HasTrackList: { signature: 'b', access: ACCESS_READ },
                Identity: { signature: 's', access: ACCESS_READ },
                SupportedUriSchemes: { signature: 'as', access: ACCESS_READ },
                SupportedMimeTypes: { signature: 'as', access: ACCESS_READ }
            }
        };

        // Create Player interface
        const playerIface = {
            name: 'org.mpris.MediaPlayer2.Player',
            methods: {
                Next: {},
                Previous: {},
                Pause: {},
                PlayPause: {},
                Stop: {},
                Play: {},
                Seek: { inSignature: 'x' },
                SetPosition: { inSignature: 'ox' }
            },
            properties: {
                PlaybackStatus: { signature: 's', access: ACCESS_READ },
                Metadata: { signature: 'a{sv}', access: ACCESS_READ },
                Volume: { signature: 'd', access: ACCESS_READWRITE },
                Position: { signature: 'x', access: ACCESS_READ },
                Rate: { signature: 'd', access: ACCESS_READ },
                MinimumRate: { signature: 'd', access: ACCESS_READ },
                MaximumRate: { signature: 'd', access: ACCESS_READ },
                CanGoNext: { signature: 'b', access: ACCESS_READ },
                CanGoPrevious: { signature: 'b', access: ACCESS_READ },
                CanPlay: { signature: 'b', access: ACCESS_READ },
                CanPause: { signature: 'b', access: ACCESS_READ },
                CanSeek: { signature: 'b', access: ACCESS_READ },
                CanControl: { signature: 'b', access: ACCESS_READ }
            }
        };

        // Create MediaPlayer2 implementation
        class MediaPlayer2 extends Interface {
            Raise() {}
            Quit() { process.exit(0); }
            get CanQuit() { return true; }
            get CanRaise() { return false; }
            get HasTrackList() { return false; }
            get Identity() { return 'Roon'; }
            get SupportedUriSchemes() { return []; }
            get SupportedMimeTypes() { return ['audio/flac', 'audio/mpeg']; }
        }

        // Create Player implementation
        const bridge = this;
        class Player extends Interface {
            Next() { bridge.control('next'); }
            Previous() { bridge.control('previous'); }
            Pause() { bridge.control('pause'); }
            PlayPause() { bridge.control('playpause'); }
            Stop() { bridge.control('stop'); }
            Play() { bridge.control('play'); }
            Seek(offset) { bridge.seek(offset); }
            SetPosition(trackId, position) { bridge.seekAbsolute(position); }

            get PlaybackStatus() { return bridge._playbackStatus; }
            get Metadata() { return bridge._metadata; }
            get Volume() { return bridge._volume; }
            set Volume(value) { bridge._volume = value; bridge.setVolume(value); }
            get Position() { return bridge._position; }
            get Rate() { return 1.0; }
            get MinimumRate() { return 1.0; }
            get MaximumRate() { return 1.0; }
            get CanGoNext() { return true; }
            get CanGoPrevious() { return true; }
            get CanPlay() { return true; }
            get CanPause() { return true; }
            get CanSeek() { return true; }
            get CanControl() { return true; }
        }

        // Add decorators manually
        MediaPlayer2.configureMembers(mediaPlayer2Iface);
        Player.configureMembers(playerIface);

        // Create instances
        this.mediaPlayer2 = new MediaPlayer2('org.mpris.MediaPlayer2');
        this.player = new Player('org.mpris.MediaPlayer2.Player');

        // Export on D-Bus
        this.bus.export('/org/mpris/MediaPlayer2', this.mediaPlayer2);
        this.bus.export('/org/mpris/MediaPlayer2', this.player);

        console.log('MPRIS interface registered on D-Bus');
    }

    async initRoonZonesInterface() {
        const bridge = this;

        // Custom Roon Zones interface - exposes individual outputs for grouped zones
        const roonZonesIface = {
            name: 'org.roon.Zones',
            methods: {
                // Returns (output_id, output_name, zone_display_name, volume, state)
                GetOutputs: { outSignature: 'a(sssds)' },
                SetOutputVolume: { inSignature: 'sd' },
                GetWaveform: { outSignature: 's' }
            },
            properties: {
                ActiveZoneId: { signature: 's', access: ACCESS_READ }
            },
        };

        class RoonZones extends Interface {
            GetOutputs() {
                const outputs = [];
                for (const [, zone] of bridge.zones) {
                    if (!zone.outputs) continue;
                    for (const output of zone.outputs) {
                        outputs.push([
                            output.output_id,
                            output.display_name,
                            zone.display_name,
                            normalizeVolume(output.volume),
                            zone.state || 'stopped'
                        ]);
                    }
                }
                return outputs;
            }

            SetOutputVolume(outputId, volume) {
                if (!bridge.transport) return;
                for (const [, zone] of bridge.zones) {
                    if (!zone.outputs) continue;
                    for (const output of zone.outputs) {
                        if (output.output_id === outputId && output.volume) {
                            const newVol = denormalizeVolume(output.volume, volume);
                            bridge.transport.change_volume(outputId, 'absolute', newVol);
                            return;
                        }
                    }
                }
            }

            GetWaveform() {
                return JSON.stringify(bridge._waveforms.get(bridge.activeZoneId) || []);
            }

            get ActiveZoneId() {
                return bridge.activeZoneId || '';
            }
        }

        RoonZones.configureMembers(roonZonesIface);
        this.roonZones = new RoonZones('org.roon.Zones');
        this.bus.export('/org/roon/Zones', this.roonZones);

        console.log('Roon Zones interface registered on D-Bus');
    }

    async initRoonBrowseInterface() {
        const bridge = this;

        const roonBrowseIface = {
            name: 'org.roon.Browse',
            methods: {
                Search:              { inSignature: 'ss', outSignature: 's' },
                BrowseItem:          { inSignature: 'ss', outSignature: 's' },
                GetZones:            { outSignature: 's' },
                GetArtistBiography:  { inSignature: 's', outSignature: 's' },
            },
        };

        class RoonBrowse extends Interface {
            Search(query, zoneOrOutputId) {
                return new Promise((resolve) => {
                    if (!bridge.browse) {
                        resolve(JSON.stringify({ error: 'Not connected' }));
                        return;
                    }

                    const zoneId = zoneOrOutputId || bridge.activeZoneId;

                    bridge.browse.browse({
                        hierarchy: 'search',
                        input: query,
                        zone_or_output_id: zoneId,
                        pop_all: true,
                    }, (err, body) => {
                        if (err) {
                            resolve(JSON.stringify({ error: String(err) }));
                            return;
                        }

                        if (body.action === 'list') {
                            bridge.browse.load({
                                hierarchy: 'search',
                                count: 100,
                            }, (loadErr, loadBody) => {
                                if (loadErr) {
                                    resolve(JSON.stringify({ error: String(loadErr) }));
                                    return;
                                }
                                resolve(JSON.stringify({
                                    items: (loadBody.items || []).map(item => ({
                                        title:     item.title,
                                        subtitle:  item.subtitle || '',
                                        image_key: item.image_key || '',
                                        item_key:  item.item_key || '',
                                        hint:      item.hint || '',
                                    })),
                                }));
                            });
                        } else {
                            resolve(JSON.stringify({
                                action: body.action,
                                message: body.message || '',
                                items: [],
                            }));
                        }
                    });
                });
            }

            BrowseItem(itemKey, zoneOrOutputId) {
                return new Promise((resolve) => {
                    if (!bridge.browse) {
                        resolve(JSON.stringify({ error: 'Not connected' }));
                        return;
                    }

                    const zoneId = zoneOrOutputId || bridge.activeZoneId;

                    bridge.browse.browse({
                        hierarchy: 'search',
                        item_key: itemKey,
                        zone_or_output_id: zoneId,
                    }, (err, body) => {
                        if (err) {
                            resolve(JSON.stringify({ error: String(err) }));
                            return;
                        }

                        if (body.action === 'list') {
                            bridge.browse.load({
                                hierarchy: 'search',
                                count: 100,
                            }, (loadErr, loadBody) => {
                                if (loadErr) {
                                    resolve(JSON.stringify({ error: String(loadErr) }));
                                    return;
                                }
                                resolve(JSON.stringify({
                                    items: (loadBody.items || []).map(item => ({
                                        title:     item.title,
                                        subtitle:  item.subtitle || '',
                                        image_key: item.image_key || '',
                                        item_key:  item.item_key || '',
                                        hint:      item.hint || '',
                                    })),
                                }));
                            });
                        } else if (body.action === 'message') {
                            resolve(JSON.stringify({ action: 'message', message: body.message || 'Done' }));
                        } else {
                            resolve(JSON.stringify({ action: body.action || 'none', message: body.message || '' }));
                        }
                    });
                });
            }

            GetArtistBiography(artistName) {
                return new Promise((resolve) => {
                    if (!bridge.browse) {
                        resolve(JSON.stringify({ error: 'Not connected' }));
                        return;
                    }

                    const zoneId = bridge.activeZoneId;

                    // Step 1: Search for the artist
                    bridge.browse.browse({
                        hierarchy: 'browse',
                        input: artistName,
                        zone_or_output_id: zoneId,
                        pop_all: true,
                        multi_session_key: 'bio',
                    }, (err, body) => {
                        if (err) { resolve(JSON.stringify({ error: String(err) })); return; }
                        if (body.action !== 'list') {
                            resolve(JSON.stringify({ error: 'Unexpected response', action: body.action }));
                            return;
                        }

                        // Load search results
                        bridge.browse.load({
                            hierarchy: 'browse',
                            count: 20,
                            multi_session_key: 'bio',
                        }, (loadErr, loadBody) => {
                            if (loadErr) { resolve(JSON.stringify({ error: String(loadErr) })); return; }

                            const items = loadBody.items || [];

                            // Find "Artists" category or artist matching the name
                            const artistCat = items.find(i =>
                                i.title === 'Artists' || i.hint === 'list'
                            );
                            const directArtist = items.find(i =>
                                i.title?.toLowerCase() === artistName.toLowerCase() && i.hint === 'action_list'
                            );
                            const target = directArtist || artistCat;

                            if (!target || !target.item_key) {
                                resolve(JSON.stringify({
                                    error: 'Artist not found',
                                    items: items.map(i => ({ title: i.title, hint: i.hint })),
                                }));
                                return;
                            }

                            // Step 2: Browse into artist (or Artists category)
                            const browseIntoArtist = (itemKey) => {
                                bridge.browse.browse({
                                    hierarchy: 'browse',
                                    item_key: itemKey,
                                    zone_or_output_id: zoneId,
                                    multi_session_key: 'bio',
                                }, (err2, body2) => {
                                    if (err2) { resolve(JSON.stringify({ error: String(err2) })); return; }
                                    if (body2.action !== 'list') {
                                        resolve(JSON.stringify({ error: 'Cannot browse artist' }));
                                        return;
                                    }

                                    bridge.browse.load({
                                        hierarchy: 'browse',
                                        count: 50,
                                        multi_session_key: 'bio',
                                    }, (loadErr2, loadBody2) => {
                                        if (loadErr2) { resolve(JSON.stringify({ error: String(loadErr2) })); return; }

                                        const artistItems = loadBody2.items || [];

                                        // If this is the Artists category, find the specific artist
                                        const specificArtist = artistItems.find(i =>
                                            i.title?.toLowerCase() === artistName.toLowerCase()
                                        );
                                        if (specificArtist && specificArtist.item_key) {
                                            browseIntoArtist(specificArtist.item_key);
                                            return;
                                        }

                                        // We're on the artist page — find biography/about
                                        const bioItem = artistItems.find(i =>
                                            /biography|about|bio/i.test(i.title || '')
                                        );

                                        if (bioItem && bioItem.item_key) {
                                            // Step 3: Browse into biography
                                            bridge.browse.browse({
                                                hierarchy: 'browse',
                                                item_key: bioItem.item_key,
                                                zone_or_output_id: zoneId,
                                                multi_session_key: 'bio',
                                            }, (err3, body3) => {
                                                if (err3) { resolve(JSON.stringify({ error: String(err3) })); return; }

                                                bridge.browse.load({
                                                    hierarchy: 'browse',
                                                    count: 10,
                                                    multi_session_key: 'bio',
                                                }, (loadErr3, loadBody3) => {
                                                    if (loadErr3) { resolve(JSON.stringify({ error: String(loadErr3) })); return; }

                                                    const bioItems = loadBody3.items || [];
                                                    // Biography text is usually in the subtitle or title of items
                                                    const text = bioItems.map(i => i.title || i.subtitle || '').filter(Boolean).join('\n\n');

                                                    resolve(JSON.stringify({
                                                        text: text || 'No biography text found',
                                                        source: 'Roon',
                                                        items: bioItems.map(i => ({ title: i.title?.substring(0, 80), subtitle: i.subtitle?.substring(0, 80) })),
                                                    }));
                                                });
                                            });
                                        } else {
                                            // No bio item found — return the page sections for debugging
                                            resolve(JSON.stringify({
                                                error: 'No biography section found on artist page',
                                                sections: artistItems.map(i => ({ title: i.title, hint: i.hint })),
                                            }));
                                        }
                                    });
                                });
                            };

                            browseIntoArtist(target.item_key);
                        });
                    });
                });
            }

            GetZones() {
                const zones = [];
                for (const [zoneId, zone] of bridge.zones) {
                    zones.push({
                        zone_id: zoneId,
                        display_name: zone.display_name,
                        state: zone.state || 'stopped',
                    });
                }
                return JSON.stringify(zones);
            }
        }

        RoonBrowse.configureMembers(roonBrowseIface);
        this.roonBrowse = new RoonBrowse('org.roon.Browse');
        this.bus.export('/org/roon/Browse', this.roonBrowse);

        console.log('Roon Browse interface registered on D-Bus');
    }

    emitPropertiesChanged(changedProps) {
        if (this.player) {
            Interface.emitPropertiesChanged(this.player, changedProps, []);
        }
    }

    startImageServer() {
        const app = express();
        const port = parseInt(process.env.ROON_IMAGE_PORT || '18793', 10);
        this.imagePort = port;

        app.get('/image/:key', (req, res) => {
            if (!this.image) {
                return res.status(503).send('Roon not connected');
            }

            this.image.get_image(req.params.key, {
                scale: 'fit',
                width: 300,
                height: 300,
                format: 'image/jpeg'
            }, (err, contentType, body) => {
                if (err) {
                    console.error('Image error:', err);
                    res.status(404).send('Image not found');
                } else {
                    res.set('Content-Type', contentType);
                    res.set('Cache-Control', 'public, max-age=86400');
                    res.send(body);
                }
            });
        });

        this.imageServer = app.listen(port, '127.0.0.1', () => {
            console.log(`Image server running on http://127.0.0.1:${port}`);
        });
        this.imageServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`Port ${port} in use, retrying in 3s...`);
                setTimeout(() => {
                    this.imageServer.close();
                    this.imageServer = app.listen(port, '127.0.0.1');
                }, 3000);
            }
        });
    }

    onCorePaired(core) {
        console.log('Roon Core paired:', core.display_name);
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this.core = core;
        this.transport = core.services.RoonApiTransport;
        this.image = core.services.RoonApiImage;
        this.browse = core.services.RoonApiBrowse;

        // Subscribe to zone updates
        this.transport.subscribe_zones((cmd, data) => {
            this.handleZoneUpdate(cmd, data);
        });
    }

    onCoreUnpaired(core) {
        console.log('Roon Core unpaired');
        this.core = null;
        this.transport = null;
        this.image = null;
        this.browse = null;
        this.zones.clear();
        this.activeZoneId = null;

        this._playbackStatus = 'Stopped';
        this._metadata = {};
        this.emitPropertiesChanged({ PlaybackStatus: 'Stopped', Metadata: {} });

        // Watchdog: if not re-paired within 30s, restart discovery
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => {
            if (!this.core && this.roon?._sood) {
                console.log('Reconnect watchdog: forcing SOOD re-query...');
                this.roon._sood.query({ query_service_id: SOOD_ID });
                this.scheduleReconnect();
            }
        }, 15000);
    }

    handleZoneUpdate(cmd, data) {
        if (cmd === 'WaveformChanged') {
            if (data.zone_id && data.waveform) {
                this._waveforms.set(data.zone_id, data.waveform);
            }
            return;
        }
        if (cmd === 'Subscribed' || cmd === 'Changed') {
            if (data.zones) {
                data.zones.forEach(zone => this.zones.set(zone.zone_id, zone));
            }
            if (data.zones_added) {
                data.zones_added.forEach(zone => this.zones.set(zone.zone_id, zone));
            }
            if (data.zones_changed) {
                data.zones_changed.forEach(zone => this.zones.set(zone.zone_id, zone));
            }
            if (data.zones_removed) {
                data.zones_removed.forEach(zoneId => this.zones.delete(zoneId));
            }

            this.selectActiveZone();
            this.updateMprisState();
        }
    }

    selectActiveZone() {
        if (this.activeZoneId && this.zones.has(this.activeZoneId)) {
            const zone = this.zones.get(this.activeZoneId);
            if (zone.state === 'playing') return;
        }

        for (const [id, zone] of this.zones) {
            if (zone.state === 'playing') {
                this.activeZoneId = id;
                console.log('Active zone:', zone.display_name);
                return;
            }
        }

        if (this.zones.size > 0 && !this.activeZoneId) {
            this.activeZoneId = this.zones.keys().next().value;
            const zone = this.zones.get(this.activeZoneId);
            console.log('Active zone (fallback):', zone.display_name);
        }
    }

    updateMprisState() {
        const zone = this.zones.get(this.activeZoneId);
        if (!zone) {
            this._playbackStatus = 'Stopped';
            this.emitPropertiesChanged({ PlaybackStatus: 'Stopped' });
            return;
        }

        const newStatus = this.mapPlayState(zone.state);
        const statusChanged = this._playbackStatus !== newStatus;
        this._playbackStatus = newStatus;

        if (zone.now_playing) {
            const np = zone.now_playing;
            const imageUrl = np.image_key
                ? `http://127.0.0.1:${this.imagePort}/image/${np.image_key}`
                : '';

            this._metadata = {
                'mpris:trackid': new dbus.Variant('o', '/org/mpris/MediaPlayer2/Track/' + Date.now()),
                'mpris:length': new dbus.Variant('x', BigInt((np.length || 0) * 1000000)),
                'mpris:artUrl': new dbus.Variant('s', imageUrl),
                'xesam:title': new dbus.Variant('s', np.three_line?.line1 || 'Unknown'),
                'xesam:artist': new dbus.Variant('as', [np.three_line?.line2 || 'Unknown Artist']),
                'xesam:album': new dbus.Variant('s', np.three_line?.line3 || '')
            };

            if (np.seek_position !== undefined) {
                this._position = BigInt(Math.floor(np.seek_position * 1000000));
            }
        }

        if (zone.outputs && zone.outputs.length > 0) {
            this._volume = normalizeVolume(zone.outputs[0].volume);
        }

        const changed = { Metadata: this._metadata };
        if (statusChanged) changed.PlaybackStatus = this._playbackStatus;
        this.emitPropertiesChanged(changed);
    }

    control(action) {
        if (!this.transport || !this.activeZoneId) {
            console.log('Cannot control: no transport or active zone');
            return;
        }
        console.log('Control:', action);
        this.transport.control(this.activeZoneId, action);
    }

    seek(offset) {
        const zone = this.zones.get(this.activeZoneId);
        if (zone && this.transport) {
            const currentPos = zone.now_playing?.seek_position || 0;
            const newPos = currentPos + (Number(offset) / 1000000);
            this.transport.seek(this.activeZoneId, 'absolute', Math.max(0, newPos));
        }
    }

    seekAbsolute(position) {
        if (this.transport && this.activeZoneId) {
            this.transport.seek(this.activeZoneId, 'absolute', Number(position) / 1000000);
        }
    }

    setVolume(vol) {
        const zone = this.zones.get(this.activeZoneId);
        if (!zone || !this.transport) return;

        if (zone.outputs && zone.outputs.length > 0) {
            const output = zone.outputs[0];
            if (output.volume) {
                const newVol = denormalizeVolume(output.volume, vol);
                this.transport.change_volume(output.output_id, 'absolute', newVol);
            }
        }
    }

    mapPlayState(state) {
        switch (state) {
            case 'playing': return 'Playing';
            case 'paused': return 'Paused';
            case 'loading': return 'Playing';
            default: return 'Stopped';
        }
    }
}

// Start the bridge
const bridge = new RoonMprisBridge();
bridge.start().catch(err => {
    console.error('Failed to start bridge:', err);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    process.exit(0);
});
