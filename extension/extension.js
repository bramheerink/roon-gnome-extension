import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const ROON_ZONES_IFACE = `
<node>
  <interface name="org.roon.Zones">
    <method name="GetOutputs">
      <arg type="a(sssds)" direction="out" name="outputs"/>
    </method>
    <method name="SetOutputVolume">
      <arg type="s" direction="in" name="output_id"/>
      <arg type="d" direction="in" name="volume"/>
    </method>
    <property name="ActiveZoneId" type="s" access="read"/>
  </interface>
</node>`;

const RoonZonesProxy = Gio.DBusProxy.makeProxyWrapper(ROON_ZONES_IFACE);

const MPRIS_PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Play"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Stop"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
  </interface>
</node>`;

const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_IFACE);

const RoonIndicator = GObject.registerClass(
class RoonIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Roon Music');

        this._extension = extension;
        this._proxy = null;
        this._watchId = null;
        this._httpSession = new Soup.Session();
        this._currentArtUrl = null;
        this._metadata = null;
        this._playbackStatus = 'Stopped';

        // Create panel box
        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box roon-panel-box'
        });
        this.add_child(this._box);

        // Roon icon
        this._icon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'system-status-icon'
        });
        this._box.add_child(this._icon);

        // Track label
        this._label = new St.Label({
            text: 'Roon',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'roon-panel-label'
        });
        this._box.add_child(this._label);

        // Play/Pause button
        this._playPauseBtn = new St.Button({
            style_class: 'roon-panel-button',
            child: new St.Icon({
                icon_name: 'media-playback-start-symbolic',
                style_class: 'system-status-icon'
            }),
            reactive: true,
            track_hover: true
        });
        this._playPauseBtn.connect('button-press-event', () => {
            this._onPlayPause();
            return Clutter.EVENT_STOP;
        });
        this._box.add_child(this._playPauseBtn);

        // Next button
        this._nextBtn = new St.Button({
            style_class: 'roon-panel-button',
            child: new St.Icon({
                icon_name: 'media-skip-forward-symbolic',
                style_class: 'system-status-icon'
            }),
            reactive: true,
            track_hover: true
        });
        this._nextBtn.connect('button-press-event', () => {
            this._onNext();
            return Clutter.EVENT_STOP;
        });
        this._box.add_child(this._nextBtn);

        // Build popup menu
        this._buildPopupMenu();

        // Refresh zones when menu opens
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._refreshZones();
            }
        });

        // Watch for MPRIS service
        this._startWatching();
    }

    _buildPopupMenu() {
        // Top row: Album art + info side by side
        this._topBox = new St.BoxLayout({
            style_class: 'roon-top-box'
        });

        // Album art (smaller)
        this._albumArtBin = new St.Bin({
            style_class: 'roon-album-art-bin'
        });
        this._albumArt = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'roon-album-art',
            icon_size: 80
        });
        this._albumArtBin.set_child(this._albumArt);
        this._topBox.add_child(this._albumArtBin);

        // Info + controls column
        this._rightBox = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-right-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });

        // Track info
        this._titleLabel = new St.Label({
            text: 'Not Playing',
            style_class: 'roon-title-label'
        });
        this._rightBox.add_child(this._titleLabel);

        this._artistLabel = new St.Label({
            text: '',
            style_class: 'roon-artist-label'
        });
        this._rightBox.add_child(this._artistLabel);

        this._albumLabel = new St.Label({
            text: '',
            style_class: 'roon-album-label'
        });
        this._rightBox.add_child(this._albumLabel);

        // Playback controls inline
        this._controlsBox = new St.BoxLayout({
            style_class: 'roon-controls-box'
        });

        this._prevButton = this._createControlButton('media-skip-backward-symbolic', () => this._onPrevious());
        this._controlsBox.add_child(this._prevButton);

        this._playPauseButton = this._createControlButton('media-playback-start-symbolic', () => this._onPlayPause());
        this._controlsBox.add_child(this._playPauseButton);

        this._nextButton = this._createControlButton('media-skip-forward-symbolic', () => this._onNext());
        this._controlsBox.add_child(this._nextButton);

        this._rightBox.add_child(this._controlsBox);
        this._topBox.add_child(this._rightBox);

        const topItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        topItem.add_child(this._topBox);
        this.menu.addMenuItem(topItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Zones section - will be populated dynamically
        this._zonesContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-zones-container',
            x_expand: true
        });

        const zonesItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        zonesItem.add_child(this._zonesContainer);
        this.menu.addMenuItem(zonesItem);

        this._zoneWidgets = new Map();
    }

    _updateOutputsUI(outputs) {
        // outputs is array of [output_id, output_name, zone_name, volume, state]
        const existingIds = new Set(this._zoneWidgets.keys());
        const newIds = new Set(outputs.map(o => o[0]));

        // Remove old outputs
        for (const id of existingIds) {
            if (!newIds.has(id)) {
                const widget = this._zoneWidgets.get(id);
                widget.box.destroy();
                this._zoneWidgets.delete(id);
            }
        }

        // Add/update outputs
        for (const [outputId, outputName, zoneName, volume, state] of outputs) {
            if (this._zoneWidgets.has(outputId)) {
                // Update existing
                const widget = this._zoneWidgets.get(outputId);
                widget.slider.value = volume;
                widget.stateIcon.icon_name = state === 'playing'
                    ? 'media-playback-start-symbolic'
                    : 'media-playback-pause-symbolic';
            } else {
                // Create new output widget
                const box = new St.BoxLayout({
                    style_class: 'roon-zone-box',
                    x_expand: true
                });

                const stateIcon = new St.Icon({
                    icon_name: state === 'playing' ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic',
                    style_class: 'roon-zone-state-icon',
                    icon_size: 16
                });
                box.add_child(stateIcon);

                const label = new St.Label({
                    text: outputName,
                    style_class: 'roon-zone-label',
                    y_align: Clutter.ActorAlign.CENTER
                });
                box.add_child(label);

                const slider = new Slider.Slider(volume);
                slider.x_expand = true;
                slider.connect('notify::value', () => {
                    this._onOutputVolumeChanged(outputId, slider.value);
                });
                box.add_child(slider);

                this._zonesContainer.add_child(box);
                this._zoneWidgets.set(outputId, { box, slider, label, stateIcon });
            }
        }
    }

    _onOutputVolumeChanged(outputId, volume) {
        if (this._zonesProxy) {
            this._zonesProxy.SetOutputVolumeRemote(outputId, volume);
        }
    }

    _refreshZones() {
        if (this._zonesProxy) {
            this._zonesProxy.GetOutputsRemote((result, err) => {
                if (!err && result) {
                    this._updateOutputsUI(result[0]);
                }
            });
        }
    }

    _createControlButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'roon-control-button',
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 20
            })
        });
        button.connect('clicked', callback);
        return button;
    }

    _startWatching() {
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            'org.mpris.MediaPlayer2.roon',
            Gio.BusNameWatcherFlags.NONE,
            this._onNameAppeared.bind(this),
            this._onNameVanished.bind(this)
        );
    }

    _onNameAppeared(connection, name, owner) {
        console.log('Roon MPRIS service appeared');

        this._proxy = new MprisPlayerProxy(
            Gio.DBus.session,
            'org.mpris.MediaPlayer2.roon',
            '/org/mpris/MediaPlayer2',
            (proxy, error) => {
                if (error) {
                    console.error('Failed to create proxy:', error);
                    return;
                }

                this._proxy.connect('g-properties-changed', this._onPropertiesChanged.bind(this));
                this._updateFromProxy();
            }
        );

        // Connect to Roon Zones interface
        this._zonesProxy = new RoonZonesProxy(
            Gio.DBus.session,
            'org.mpris.MediaPlayer2.roon',
            '/org/roon/Zones',
            (proxy, error) => {
                if (error) {
                    console.error('Failed to create zones proxy:', error);
                    return;
                }

                // Get initial zones
                this._refreshZones();
            }
        );

        this._label.text = 'Roon';
        this.visible = true;
    }

    _onNameVanished(connection, name) {
        console.log('Roon MPRIS service vanished');
        this._proxy = null;
        this._label.text = 'Roon (offline)';
        this._titleLabel.text = 'Bridge not running';
        this._artistLabel.text = '';
        this._albumLabel.text = '';
        this._playbackStatus = 'Stopped';
        this._updatePlayPauseIcon();
    }

    _onPropertiesChanged(proxy, changed, invalidated) {
        const props = changed.deepUnpack();

        if ('Metadata' in props) {
            this._updateMetadata(props.Metadata.deepUnpack());
        }

        if ('PlaybackStatus' in props) {
            this._playbackStatus = props.PlaybackStatus.unpack();
            this._updatePlayPauseIcon();
        }
    }

    _updateFromProxy() {
        if (!this._proxy) return;

        try {
            if (this._proxy.Metadata) {
                this._updateMetadata(this._proxy.Metadata);
            }

            if (this._proxy.PlaybackStatus) {
                this._playbackStatus = this._proxy.PlaybackStatus;
                this._updatePlayPauseIcon();
            }
        } catch (e) {
            console.error('Error updating from proxy:', e);
        }
    }

    _updateMetadata(metadata) {
        const title = metadata['xesam:title']?.unpack?.() || metadata['xesam:title'] || 'Unknown';
        const artistArr = metadata['xesam:artist']?.deepUnpack?.() || metadata['xesam:artist'] || [];
        const artist = Array.isArray(artistArr) ? artistArr[0] || 'Unknown Artist' : artistArr;
        const album = metadata['xesam:album']?.unpack?.() || metadata['xesam:album'] || '';
        const artUrl = metadata['mpris:artUrl']?.unpack?.() || metadata['mpris:artUrl'] || '';

        this._metadata = { title, artist, album, artUrl };

        // Update labels
        this._titleLabel.text = title;
        this._artistLabel.text = artist;
        this._albumLabel.text = album;

        // Update panel label
        const panelText = `${title} - ${artist}`;
        this._label.text = panelText.length > 40 ? panelText.substring(0, 37) + '...' : panelText;

        // Load album art if changed
        if (artUrl && artUrl !== this._currentArtUrl) {
            this._currentArtUrl = artUrl;
            this._loadAlbumArt(artUrl);
        }
    }

    _updatePlayPauseIcon() {
        const iconName = this._playbackStatus === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        this._playPauseBtn.child.icon_name = iconName;
        this._playPauseButton.child.icon_name = iconName;
    }

    _loadAlbumArt(url) {
        const message = Soup.Message.new('GET', url);

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    if (message.get_status() !== Soup.Status.OK) {
                        console.log('Failed to fetch album art:', message.get_status());
                        return;
                    }

                    const bytes = session.send_and_read_finish(result);
                    const data = bytes.get_data();

                    if (!data || data.length === 0) {
                        return;
                    }

                    // Create GInputStream from bytes
                    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);

                    GdkPixbuf.Pixbuf.new_from_stream_async(
                        stream,
                        null,
                        (source, asyncResult) => {
                            try {
                                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(asyncResult);
                                this._setAlbumArtFromPixbuf(pixbuf);
                            } catch (e) {
                                console.error('Failed to decode album art:', e);
                            }
                        }
                    );
                } catch (e) {
                    console.error('Failed to load album art:', e);
                }
            }
        );
    }

    _setAlbumArtFromPixbuf(pixbuf) {
        try {
            // Scale pixbuf to desired size
            const scaled = pixbuf.scale_simple(80, 80, GdkPixbuf.InterpType.BILINEAR);

            // Save to temp file and use Gio.FileIcon
            const tempPath = '/tmp/roon-album-art.jpg';
            scaled.savev(tempPath, 'jpeg', [], []);

            const file = Gio.File.new_for_path(tempPath);
            const gicon = new Gio.FileIcon({ file });

            // Create new icon widget
            const newArt = new St.Icon({
                gicon: gicon,
                icon_size: 80,
                style_class: 'roon-album-art-image'
            });

            // Replace album art
            this._albumArtBin.set_child(newArt);
            this._albumArt = newArt;
        } catch (e) {
            console.error('Failed to set album art:', e);
        }
    }

    _onPlayPause() {
        if (this._proxy) {
            this._proxy.PlayPauseRemote();
        }
    }

    _onNext() {
        if (this._proxy) {
            this._proxy.NextRemote();
        }
    }

    _onPrevious() {
        if (this._proxy) {
            this._proxy.PreviousRemote();
        }
    }

    destroy() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = null;
        }
        this._proxy = null;
        this._zonesProxy = null;
        super.destroy();
    }
});

export default class RoonExtension extends Extension {
    enable() {
        this._indicator = new RoonIndicator(this);
        Main.panel.addToStatusArea('roon-indicator', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
