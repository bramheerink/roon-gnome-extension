import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

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

const ROON_BROWSE_IFACE = `
<node>
  <interface name="org.roon.Browse">
    <method name="Search">
      <arg type="s" direction="in" name="query"/>
      <arg type="s" direction="in" name="zone_or_output_id"/>
      <arg type="s" direction="out" name="results_json"/>
    </method>
    <method name="BrowseItem">
      <arg type="s" direction="in" name="item_key"/>
      <arg type="s" direction="in" name="zone_or_output_id"/>
      <arg type="s" direction="out" name="results_json"/>
    </method>
    <method name="GetZones">
      <arg type="s" direction="out" name="zones_json"/>
    </method>
  </interface>
</node>`;

const RoonBrowseProxy = Gio.DBusProxy.makeProxyWrapper(ROON_BROWSE_IFACE);

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
        this._settings = extension.getSettings();
        this._proxy = null;
        this._browseProxy = null;
        this._watchId = null;
        this._httpSession = new Soup.Session();
        this._currentArtUrl = null;
        this._metadata = null;
        this._playbackStatus = 'Stopped';
        this._selectedZoneId = null;

        // Create panel box
        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box roon-panel-box'
        });
        this.add_child(this._box);

        // Roon icon (custom SVG)
        const iconPath = extension.path + '/icons/roon-symbolic.svg';
        const iconFile = Gio.File.new_for_path(iconPath);
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({ file: iconFile }),
            style_class: 'system-status-icon'
        });
        this._box.add_child(this._icon);

        // Panel album art thumbnail (20px)
        this._panelArt = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'roon-panel-art',
            icon_size: 20
        });
        this._panelArt.hide();
        this._box.add_child(this._panelArt);

        // Track label (only track name, artist on hover)
        this._label = new St.Label({
            text: 'Roon',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'roon-panel-label',
            reactive: true,
            track_hover: true
        });
        this._box.add_child(this._label);

        // Hover tooltip for artist info
        this._tooltip = new St.Label({
            style_class: 'roon-panel-tooltip',
            text: ''
        });
        this._tooltip.hide();
        Main.uiGroup.add_child(this._tooltip);

        this._label.connect('notify::hover', () => {
            if (this._label.hover && this._tooltip.text) {
                const [x, y] = this._label.get_transformed_position();
                const [, h] = this._label.get_transformed_size();
                this._tooltip.set_position(Math.round(x), Math.round(y + h + 4));
                this._tooltip.show();
            } else {
                this._tooltip.hide();
            }
        });

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

        // Apply show-controls-in-panel setting
        const showControls = this._settings.get_boolean('show-controls-in-panel');
        this._playPauseBtn.visible = showControls;
        this._nextBtn.visible = showControls;
        this._settingsIds = [];
        this._settingsIds.push(this._settings.connect('changed::show-controls-in-panel', () => {
            const show = this._settings.get_boolean('show-controls-in-panel');
            this._playPauseBtn.visible = show;
            this._nextBtn.visible = show;
        }));
        this._settingsIds.push(this._settings.connect('changed::hidden-output-ids', () => {
            this._refreshZones();
        }));

        // Build popup menu
        this._buildPopupMenu();

        // Refresh zones when menu opens, reset width when closed
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._refreshZones();
            } else {
                if (this._searchSection?.visible) this._hideSearch();
                this._zonePickerBox?.hide();
            }
        });

        // Watch for MPRIS service
        this._startWatching();
    }

    _buildPopupMenu() {
        // Fixed popup width
        this.menu.box.add_style_class_name('roon-popup-menu');

        // === 1. Now Playing: album art + track + artist (pure info) ===
        this._topBox = new St.BoxLayout({
            style_class: 'roon-top-box'
        });

        this._albumArtBin = new St.Bin({
            style_class: 'roon-album-art-bin'
        });
        this._albumArt = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'roon-album-art',
            icon_size: 120
        });
        this._albumArtBin.set_child(this._albumArt);
        this._topBox.add_child(this._albumArtBin);

        this._rightBox = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-right-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });

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

        this._topBox.add_child(this._rightBox);

        const topItem = new PopupMenu.PopupBaseMenuItem({ reactive: true, can_focus: false });
        topItem.add_child(this._topBox);
        topItem.connect('activate', () => {
            if (this._searchSection?.visible) this._hideSearch();
        });
        this.menu.addMenuItem(topItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // === 2. Zone selector + volume sliders ===
        this._buildZoneSection();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // === 3. Controls row: prev/play/next + search icon ===
        this._buildControlsRow();

        // === 4. Search section (hidden by default) ===
        this._buildSearchSection();
    }

    _buildZoneSection() {
        const zoneItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const zoneBox = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-zone-section',
            x_expand: true
        });

        // Zone selector row: speaker icon + combo
        const zoneSelectorBox = new St.BoxLayout({
            style_class: 'roon-zone-selector-box',
            x_expand: true
        });

        const zoneIcon = new St.Icon({
            icon_name: 'audio-speakers-symbolic',
            style_class: 'roon-zone-selector-icon',
            icon_size: 16
        });
        zoneSelectorBox.add_child(zoneIcon);

        this._zoneCombo = new St.Button({
            style_class: 'roon-zone-combo',
            label: 'Select Zone',
            x_expand: true
        });
        this._zoneCombo.connect('clicked', () => this._showZonePicker());
        zoneSelectorBox.add_child(this._zoneCombo);
        zoneBox.add_child(zoneSelectorBox);

        // Zone picker dropdown (hidden by default)
        this._zonePickerBox = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-zone-picker',
            x_expand: true
        });
        this._zonePickerBox.hide();
        zoneBox.add_child(this._zonePickerBox);

        // Volume sliders
        this._zonesContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-zones-container',
            x_expand: true
        });
        zoneBox.add_child(this._zonesContainer);

        this._zoneWidgets = new Map();

        zoneItem.add_child(zoneBox);
        this.menu.addMenuItem(zoneItem);
    }

    _buildControlsRow() {
        const controlsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const controlsRow = new St.BoxLayout({
            style_class: 'roon-controls-row',
            x_expand: true
        });

        // Playback controls (left)
        const controlsBox = new St.BoxLayout({
            style_class: 'roon-controls-box'
        });

        this._prevButton = this._createControlButton('media-skip-backward-symbolic', () => this._onPrevious());
        controlsBox.add_child(this._prevButton);

        this._playPauseButton = this._createControlButton('media-playback-start-symbolic', () => this._onPlayPause());
        controlsBox.add_child(this._playPauseButton);

        this._nextButton = this._createControlButton('media-skip-forward-symbolic', () => this._onNext());
        controlsBox.add_child(this._nextButton);

        controlsRow.add_child(controlsBox);

        // Search toggle (right)
        this._searchToggle = new St.Button({
            style_class: 'roon-search-toggle-btn',
            child: new St.Icon({
                icon_name: 'edit-find-symbolic',
                icon_size: 18
            }),
            x_expand: true,
            x_align: Clutter.ActorAlign.END
        });
        this._searchToggle.connect('clicked', () => this._toggleSearch());
        controlsRow.add_child(this._searchToggle);

        controlsItem.add_child(controlsRow);
        this.menu.addMenuItem(controlsItem);
    }

    _buildSearchSection() {
        const searchItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._searchSection = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-search-section',
            x_expand: true
        });

        // Search entry
        this._searchEntry = new St.Entry({
            hint_text: 'Search music...',
            style_class: 'roon-search-entry',
            can_focus: true,
            x_expand: true
        });
        this._searchEntry.clutter_text.connect('activate', () => {
            this._performSearch(this._searchEntry.get_text());
        });
        this._searchSection.add_child(this._searchEntry);

        // Search results (scrollable)
        this._searchResultsScroll = new St.ScrollView({
            style_class: 'roon-search-results-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true
        });
        this._searchResultsBox = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-search-results',
            x_expand: true
        });
        this._searchResultsScroll.set_child(this._searchResultsBox);
        this._searchResultsScroll.hide();
        this._searchSection.add_child(this._searchResultsScroll);

        this._searchSection.hide();
        searchItem.add_child(this._searchSection);
        this.menu.addMenuItem(searchItem);
    }

    _toggleSearch() {
        if (this._searchSection.visible) {
            this._hideSearch();
        } else {
            this._searchSection.show();
            this._searchEntry.grab_key_focus();
        }
    }

    _hideSearch() {
        this._searchSection.hide();
        this._searchResultsScroll.hide();
        this._searchResultsBox.destroy_all_children();
        this._searchEntry.set_text('');
    }

    _performSearch(query) {
        if (!query || !this._browseProxy) return;

        const zoneId = this._selectedZoneId || this._zonesProxy?.ActiveZoneId || '';

        this._showSearchMessage('Searching...');

        this._browseProxy.SearchRemote(query, zoneId, (result, err) => {
            if (err) {
                this._showSearchMessage('Search failed');
                return;
            }

            try {
                const data = JSON.parse(result[0]);
                if (data.error) {
                    this._showSearchMessage(data.error);
                    return;
                }
                this._showSearchResults(data);
            } catch (e) {
                this._showSearchMessage('Parse error');
            }
        });
    }

    _showSearchResults(data) {
        this._searchResultsBox.destroy_all_children();

        if (!data.items || data.items.length === 0) {
            this._showSearchMessage('No results');
            return;
        }

        this._searchSection.show();
        this._searchResultsScroll.show();

        for (const item of data.items) {
            const row = new St.BoxLayout({
                style_class: 'roon-search-result-row',
                x_expand: true
            });

            const textBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });

            textBox.add_child(new St.Label({
                text: item.title,
                style_class: 'roon-search-result-title'
            }));

            if (item.subtitle) {
                textBox.add_child(new St.Label({
                    text: item.subtitle,
                    style_class: 'roon-search-result-subtitle'
                }));
            }

            row.add_child(textBox);

            const btn = new St.Button({ child: row, x_expand: true, style_class: 'roon-search-result-btn' });
            btn.connect('clicked', () => {
                if (item.item_key) this._browseItem(item.item_key);
            });
            this._searchResultsBox.add_child(btn);
        }
    }

    _browseItem(itemKey) {
        const zoneId = this._selectedZoneId || this._zonesProxy?.ActiveZoneId || '';
        this._browseProxy.BrowseItemRemote(itemKey, zoneId, (result, err) => {
            if (err) return;

            try {
                const data = JSON.parse(result[0]);
                if (data.action === 'message') {
                    this._hideSearch();
                    return;
                }
                if (data.items && data.items.length > 0) {
                    this._showSearchResults(data);
                }
            } catch (e) {
                // ignore
            }
        });
    }

    _showSearchMessage(text) {
        this._searchResultsBox.destroy_all_children();
        this._searchSection.show();
        this._searchResultsScroll.show();
        this._searchResultsBox.add_child(new St.Label({
            text: text,
            style_class: 'roon-search-message',
            x_align: Clutter.ActorAlign.CENTER
        }));
    }

    _showZonePicker() {
        if (!this._browseProxy) return;

        // Toggle: if already showing, hide it
        if (this._zonePickerBox.visible) {
            this._zonePickerBox.hide();
            return;
        }

        this._browseProxy.GetZonesRemote((result, err) => {
            if (err) return;

            try {
                const zones = JSON.parse(result[0]);
                this._zonePickerBox.destroy_all_children();
                this._zonePickerBox.show();

                for (const zone of zones) {
                    const btn = new St.Button({
                        style_class: 'roon-zone-picker-item',
                        x_expand: true,
                        child: new St.Label({ text: zone.display_name })
                    });
                    btn.connect('clicked', () => {
                        this._selectedZoneId = zone.zone_id;
                        this._zoneCombo.label = zone.display_name;
                        this._zonePickerBox.hide();
                        this._refreshZones();
                    });
                    this._zonePickerBox.add_child(btn);
                }
            } catch (e) {
                // ignore
            }
        });
    }

    _updateOutputsUI(outputs) {
        // Only show outputs for the selected zone
        const zoneName = this._zoneCombo?.label !== 'Select Zone' ? this._zoneCombo?.label : null;
        const hiddenIds = this._settings.get_strv('hidden-output-ids');
        const visibleOutputs = outputs.filter(o =>
            (!zoneName || o[2] === zoneName) && !hiddenIds.includes(o[0])
        );

        const existingIds = new Set(this._zoneWidgets.keys());
        const newIds = new Set(visibleOutputs.map(o => o[0]));

        // Remove old outputs
        for (const id of existingIds) {
            if (!newIds.has(id)) {
                const widget = this._zoneWidgets.get(id);
                widget.box.destroy();
                this._zoneWidgets.delete(id);
            }
        }

        // Add/update outputs
        for (const [outputId, outputName, zoneName, volume, state] of visibleOutputs) {
            if (this._zoneWidgets.has(outputId)) {
                const widget = this._zoneWidgets.get(outputId);
                widget.slider.value = volume;
                widget.stateIcon.icon_name = state === 'playing'
                    ? 'media-playback-start-symbolic'
                    : 'media-playback-pause-symbolic';
            } else {
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
                    const outputs = result[0];

                    // Auto-select active zone if none selected
                    if (this._zoneCombo?.label === 'Select Zone' && outputs.length > 0) {
                        // Find the playing zone, or fall back to first
                        const playing = outputs.find(o => o[4] === 'playing');
                        const zoneName = playing ? playing[2] : outputs[0][2];
                        this._zoneCombo.label = zoneName;
                    }

                    this._updateOutputsUI(outputs);
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
                this._refreshZones();
            }
        );

        // Connect to Roon Browse interface
        this._browseProxy = new RoonBrowseProxy(
            Gio.DBus.session,
            'org.mpris.MediaPlayer2.roon',
            '/org/roon/Browse',
            (proxy, error) => {
                if (error) {
                    console.error('Failed to create browse proxy:', error);
                }
            }
        );

        this._label.text = 'Roon';
        this.visible = true;
    }

    _onNameVanished(connection, name) {
        console.log('Roon MPRIS service vanished');
        this._proxy = null;
        this._browseProxy = null;
        this._label.text = 'Roon (offline)';
        this._titleLabel.text = 'Bridge not running';
        this._artistLabel.text = '';
        this._playbackStatus = 'Stopped';
        this._panelArt.hide();
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

        // Update popup labels
        this._titleLabel.text = title;
        this._artistLabel.text = artist;

        // Panel: only track name, artist on hover
        const maxLen = this._settings.get_int('label-max-length');
        this._label.text = title.length > maxLen ? title.substring(0, maxLen - 3) + '...' : title;
        this._tooltip.text = `${title} - ${artist}`;

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
                        return;
                    }

                    const bytes = session.send_and_read_finish(result);
                    const data = bytes.get_data();

                    if (!data || data.length === 0) {
                        return;
                    }

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
            // Popup art (120x120)
            const scaled = pixbuf.scale_simple(120, 120, GdkPixbuf.InterpType.BILINEAR);
            const tempPath = `/tmp/roon-album-art-${Date.now()}.jpg`;
            scaled.savev(tempPath, 'jpeg', [], []);

            const file = Gio.File.new_for_path(tempPath);
            const gicon = new Gio.FileIcon({ file });

            const newArt = new St.Icon({
                gicon: gicon,
                icon_size: 120,
                style_class: 'roon-album-art-image'
            });

            this._albumArtBin.set_child(newArt);
            this._albumArt = newArt;

            // Panel art (20x20)
            const panelScaled = pixbuf.scale_simple(20, 20, GdkPixbuf.InterpType.BILINEAR);
            const panelTempPath = `/tmp/roon-panel-art-${Date.now()}.jpg`;
            panelScaled.savev(panelTempPath, 'jpeg', [], []);

            const panelFile = Gio.File.new_for_path(panelTempPath);
            const panelGicon = new Gio.FileIcon({ file: panelFile });
            this._panelArt.set_gicon(panelGicon);
            this._panelArt.show();
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
        for (const id of this._settingsIds) {
            this._settings.disconnect(id);
        }
        this._tooltip?.destroy();
        this._proxy = null;
        this._browseProxy = null;
        this._zonesProxy = null;
        super.destroy();
    }
});

export default class RoonExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new RoonIndicator(this);
        Main.panel.addToStatusArea('roon-indicator', this._indicator);

        // Register global hotkey
        Main.wm.addKeybinding(
            'toggle-play-pause',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._indicator?._onPlayPause();
            }
        );
    }

    disable() {
        Main.wm.removeKeybinding('toggle-play-pause');
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
