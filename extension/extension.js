import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
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
    <method name="GetWaveform">
      <arg type="s" direction="out" name="waveform_json"/>
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
    <method name="GetArtistBiography">
      <arg type="s" direction="in" name="artist_name"/>
      <arg type="s" direction="out" name="biography_json"/>
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
        this._lastControlTime = 0;
        this._trackLength = 0;
        this._progressFraction = 0;
        this._progressTimerId = null;
        this._waveformData = null;
        this._vuBars = new Float64Array(8);
        this._vuTimerId = null;
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
                if (this._playbackStatus === 'Playing' && this._waveformData) {
                    this._startVUTimer();
                }
            } else {
                this._stopVUTimer();
                if (this._searchSection?.visible) this._hideSearch();
                if (this._bioSection?.visible) this._hideBiography();
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

        this._artContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: 120,
            height: 120,
        });
        this._albumArtBin = new St.Bin({
            style_class: 'roon-album-art-bin',
            width: 120,
            height: 120,
        });
        this._albumArt = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'roon-album-art',
            icon_size: 120
        });
        this._albumArtBin.set_child(this._albumArt);
        this._artContainer.add_child(this._albumArtBin);

        this._progressDraw = new St.DrawingArea({
            width: 120,
            height: 120,
            reactive: false,
        });
        this._progressDraw.connect('repaint', (area) => this._drawProgress(area));
        this._artContainer.add_child(this._progressDraw);

        this._topBox.add_child(this._artContainer);

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
        this._artistButton = new St.Button({
            child: this._artistLabel,
            style_class: 'roon-artist-button',
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._artistButton.connect('clicked', () => this._toggleBiography());
        this._rightBox.add_child(this._artistButton);

        this._topBox.add_child(this._rightBox);

        const topItem = new PopupMenu.PopupBaseMenuItem({ reactive: true, can_focus: false });
        topItem.add_child(this._topBox);
        topItem.connect('activate', () => {
            if (this._searchSection?.visible) this._hideSearch();
        });
        this.menu.addMenuItem(topItem);

        // === VU Meter ===
        this._buildVUSection();

        const sep1 = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(sep1);

        // === 2. Zone selector + volume sliders ===
        this._buildZoneSection();

        const sep2 = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(sep2);

        // === 3. Controls row: prev/play/next + search icon ===
        this._buildControlsRow();

        // === 4. Search section (hidden by default) ===
        this._buildSearchSection();

        // Track all normal menu items for biography overlay toggle
        this._normalMenuItems = [topItem, sep1, sep2];
        // VU, zone, controls, search items are added inside their build methods
        // — we collect them via the menu's item list minus the bio item
        for (const item of this.menu._getMenuItems()) {
            if (!this._normalMenuItems.includes(item)) {
                this._normalMenuItems.push(item);
            }
        }

        // === 5. Biography section (hidden overlay) ===
        this._buildBiographySection();
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

    _buildVUSection() {
        const vuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._vuDraw = new St.DrawingArea({
            style_class: 'roon-vu-section',
            x_expand: true,
            height: 32,
            reactive: false,
        });
        this._vuDraw.connect('repaint', (area) => this._drawVUMeters(area));
        vuItem.add_child(this._vuDraw);
        this.menu.addMenuItem(vuItem);
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

    _buildBiographySection() {
        this._bioItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._bioSection = new St.BoxLayout({
            vertical: true,
            style_class: 'roon-bio-section',
            x_expand: true,
        });

        // Navigation stack for linked biographies
        this._bioHistory = [];
        this._bioLinks = [];

        // Header: back arrow + artist name
        const bioHeader = new St.BoxLayout({
            style_class: 'roon-bio-header',
            x_expand: true,
        });

        const bioBackButton = new St.Button({
            style_class: 'roon-bio-back-btn',
            child: new St.Icon({
                icon_name: 'go-previous-symbolic',
                icon_size: 16,
            }),
        });
        bioBackButton.connect('clicked', () => this._bioGoBack());
        bioHeader.add_child(bioBackButton);

        this._bioHeaderLabel = new St.Label({
            text: 'Biography',
            style_class: 'roon-bio-header-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bioHeader.add_child(this._bioHeaderLabel);

        this._bioSection.add_child(bioHeader);

        // Scrollable biography content
        this._bioScroll = new St.ScrollView({
            style_class: 'roon-bio-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });

        this._bioContentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roon-bio-content',
        });
        this._bioScroll.set_child(this._bioContentBox);
        this._bioSection.add_child(this._bioScroll);

        // Source attribution
        this._bioSourceLabel = new St.Label({
            text: '',
            style_class: 'roon-bio-source',
        });
        this._bioSection.add_child(this._bioSourceLabel);

        this._bioSection.hide();
        this._bioItem.add_child(this._bioSection);
        this._bioItem.visible = false;
        this.menu.addMenuItem(this._bioItem);
    }

    _toggleBiography() {
        if (this._bioSection.visible) {
            this._bioGoBack();
        } else {
            this._showBiography();
        }
    }

    _showBiography() {
        const artist = this._metadata?.artist;
        if (!artist || artist === 'Unknown Artist') return;

        // Hide all normal menu items, show biography
        for (const item of this._normalMenuItems) {
            item.visible = false;
        }
        this._bioItem.visible = true;
        this._bioSection.show();
        this.menu.box.add_style_class_name('roon-popup-menu-wide');

        this._bioHistory = [];
        this._navigateToBio(artist);
    }

    _navigateToBio(artistName) {
        this._bioHeaderLabel.text = artistName;
        this._setBioLoading();
        this._bioSourceLabel.text = '';

        // Scroll to top
        const vAdj = this._bioScroll.vscroll?.adjustment;
        if (vAdj) vAdj.value = 0;

        this._fetchBiography(artistName);
    }

    _bioGoBack() {
        if (this._bioHistory.length > 0) {
            const prev = this._bioHistory.pop();
            this._bioHeaderLabel.text = prev.artist;
            this._bioSourceLabel.text = prev.source;
            this._setBioContent(prev.text, prev.imageUrls);
            const vAdj = this._bioScroll.vscroll?.adjustment;
            if (vAdj) vAdj.value = 0;
        } else {
            this._hideBiography();
        }
    }

    _hideBiography() {
        this._bioSection.hide();
        this._bioItem.visible = false;
        this._bioHistory = [];
        this.menu.box.remove_style_class_name('roon-popup-menu-wide');

        // Restore normal menu items
        for (const item of this._normalMenuItems) {
            item.visible = true;
        }
    }

    _setBioLoading() {
        this._bioContentBox.destroy_all_children();
        const loadLabel = new St.Label({
            text: 'Loading biography\u2026',
            style_class: 'roon-bio-text',
            x_expand: true,
        });
        this._bioContentBox.add_child(loadLabel);
    }

    _setBioContent(rawText, imageUrls) {
        this._bioContentBox.destroy_all_children();
        this._bioLinks = [];

        // Parse markdown into paragraphs and render as widgets
        const lines = rawText.split('\n');
        let paragraph = '';

        const flushParagraph = () => {
            if (!paragraph.trim()) return;
            this._addBioParagraph(paragraph.trim());
            paragraph = '';
        };

        for (const line of lines) {
            // Strip image markdown (we load images separately)
            const stripped = line.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();

            if (stripped === '') {
                flushParagraph();
                continue;
            }

            // H2 header
            if (stripped.startsWith('## ') && !stripped.startsWith('### ')) {
                flushParagraph();
                const headerText = stripped.slice(3);
                const label = new St.Label({
                    text: headerText,
                    style_class: 'roon-bio-h2',
                    x_expand: true,
                });
                this._bioContentBox.add_child(label);
                continue;
            }

            // H3 header
            if (stripped.startsWith('### ')) {
                flushParagraph();
                const headerText = stripped.slice(4);
                const label = new St.Label({
                    text: headerText,
                    style_class: 'roon-bio-h3',
                    x_expand: true,
                });
                this._bioContentBox.add_child(label);
                continue;
            }

            // Regular text — accumulate paragraph
            if (paragraph) paragraph += ' ';
            paragraph += stripped;
        }
        flushParagraph();

        // Load images
        if (imageUrls && imageUrls.length > 0) {
            for (const img of imageUrls.slice(0, 3)) {
                this._loadBioImage(img.url, img.alt);
            }
        }
    }

    _addBioParagraph(text) {
        // Parse [Name](id) and [[id|Name]] links into Pango markup
        const linkRe = /\[([^\]]+)\]\((\d+)\)|\[\[(\d+)\|([^\]]+)\]\]/g;
        const links = [];
        let markup = '';
        let plainLen = 0; // byte length of rendered text
        let lastIdx = 0;
        let match;

        while ((match = linkRe.exec(text)) !== null) {
            // Text before the link
            const before = text.slice(lastIdx, match.index);
            markup += this._escapeMarkup(before);
            plainLen += new TextEncoder().encode(before).length;

            // The link
            const name = match[1] || match[4];
            const id = match[2] || match[3];
            const byteStart = plainLen;
            plainLen += new TextEncoder().encode(name).length;

            markup += `<span foreground="#5b9bd5">${this._escapeMarkup(name)}</span>`;
            links.push({ byteStart, byteEnd: plainLen, name, id });

            lastIdx = match.index + match[0].length;
        }

        // Remaining text
        const rest = text.slice(lastIdx);
        markup += this._escapeMarkup(rest);

        const label = new St.Label({
            style_class: 'roon-bio-text',
            x_expand: true,
        });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        label.clutter_text.set_use_markup(true);
        label.clutter_text.set_markup(markup);

        // If this paragraph has links, make it clickable
        if (links.length > 0) {
            const paraLinks = links;
            this._bioLinks.push(...paraLinks);

            label.clutter_text.reactive = true;
            label.clutter_text.connect('button-press-event', (actor, event) => {
                const [stageX, stageY] = event.get_coords();
                const [ok, localX, localY] = actor.transform_stage_point(stageX, stageY);
                if (!ok) return Clutter.EVENT_PROPAGATE;

                const layout = actor.get_layout();
                const [, byteIdx] = layout.xy_to_index(
                    localX * Pango.SCALE,
                    localY * Pango.SCALE,
                );

                for (const link of paraLinks) {
                    if (byteIdx >= link.byteStart && byteIdx < link.byteEnd) {
                        this._onBioLinkClicked(link);
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        this._bioContentBox.add_child(label);
    }

    _onBioLinkClicked(link) {
        // Save current biography to history before navigating
        // Store raw text + source for back navigation
        if (this._currentBioRaw) {
            this._bioHistory.push({
                artist: this._bioHeaderLabel.text,
                text: this._currentBioRaw,
                source: this._bioSourceLabel.text,
                imageUrls: this._currentBioImages,
            });
        }

        this._navigateToBio(link.name);
    }

    _loadBioImage(url, altText) {
        const message = Soup.Message.new('GET', url);
        if (!message) return;

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const data = bytes.get_data();
                    if (!data || data.length === 0) return;

                    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
                    stream.close(null);

                    // Scale to max 280px wide
                    const maxW = 280;
                    let w = pixbuf.get_width();
                    let h = pixbuf.get_height();
                    if (w > maxW) {
                        h = Math.round(h * maxW / w);
                        w = maxW;
                    }
                    const scaled = pixbuf.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR);

                    const clutterImage = new Clutter.Image();
                    clutterImage.set_data(
                        scaled.get_pixels(),
                        scaled.get_has_alpha()
                            ? Clutter.PixelFormat.RGBA_8888
                            : Clutter.PixelFormat.RGB_888,
                        w, h,
                        scaled.get_rowstride(),
                    );

                    const imageActor = new Clutter.Actor({
                        content: clutterImage,
                        width: w,
                        height: h,
                        x_align: Clutter.ActorAlign.CENTER,
                    });

                    // Wrap in a box with caption
                    const imageBox = new St.BoxLayout({
                        vertical: true,
                        style_class: 'roon-bio-image-box',
                        x_align: Clutter.ActorAlign.CENTER,
                    });
                    imageBox.add_child(imageActor);

                    if (altText) {
                        const caption = new St.Label({
                            text: altText.replace(/\\(.)/g, '$1'),
                            style_class: 'roon-bio-caption',
                            x_align: Clutter.ActorAlign.CENTER,
                        });
                        caption.clutter_text.set_line_wrap(true);
                        caption.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                        imageBox.add_child(caption);
                    }

                    this._bioContentBox.add_child(imageBox);
                } catch (e) {
                    // Image load failed — skip silently
                }
            }
        );
    }

    _escapeMarkup(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _fetchBiography(artistName) {
        const encoded = encodeURIComponent(artistName);
        const url = `http://127.0.0.1:18795/biography?artist=${encoded}`;
        const message = Soup.Message.new('GET', url);

        if (!message) {
            this._setBioLoading();
            return;
        }

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const data = bytes.get_data();

                    if (!data || data.length === 0) {
                        this._bioContentBox.destroy_all_children();
                        const errLabel = new St.Label({
                            text: 'No response from biography service.',
                            style_class: 'roon-bio-text',
                        });
                        this._bioContentBox.add_child(errLabel);
                        this._bioSourceLabel.text = '';
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const json = JSON.parse(decoder.decode(data));

                    if (json.error) {
                        this._bioContentBox.destroy_all_children();
                        const errLabel = new St.Label({
                            text: json.error,
                            style_class: 'roon-bio-text',
                        });
                        this._bioContentBox.add_child(errLabel);
                        this._bioSourceLabel.text = '';
                    } else {
                        const rawText = json.text || 'No biography available.';

                        // Extract image URLs before rendering
                        const imageUrls = [];
                        const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
                        let imgMatch;
                        while ((imgMatch = imgRe.exec(rawText)) !== null) {
                            imageUrls.push({ alt: imgMatch[1], url: imgMatch[2] });
                        }

                        this._currentBioRaw = rawText;
                        this._currentBioImages = imageUrls;
                        this._setBioContent(rawText, imageUrls);
                        this._bioSourceLabel.text = json.source
                            ? `Source: ${json.source}`
                            : '';
                    }
                } catch (e) {
                    this._bioContentBox.destroy_all_children();
                    const errLabel = new St.Label({
                        text: 'Failed to load biography.',
                        style_class: 'roon-bio-text',
                    });
                    this._bioContentBox.add_child(errLabel);
                    this._bioSourceLabel.text = '';
                }
            }
        );
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
            if (this._playbackStatus === 'Playing') {
                this._startProgressTimer();
                if (this.menu.isOpen && this._waveformData) this._startVUTimer();
            } else {
                this._stopProgressTimer();
                this._stopVUTimer();
                this._updateProgress();
            }
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
                if (this._playbackStatus === 'Playing') {
                    this._startProgressTimer();
                    if (this.menu.isOpen && this._waveformData) this._startVUTimer();
                } else {
                    this._stopProgressTimer();
                    this._stopVUTimer();
                    this._updateProgress();
                }
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
        const length = metadata['mpris:length']?.unpack?.() || metadata['mpris:length'] || 0;
        this._trackLength = Number(length);

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
            this._fetchWaveform();
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

    _isControlThrottled() {
        const now = GLib.get_monotonic_time();
        if (now - this._lastControlTime < 500000) return true; // 500ms
        this._lastControlTime = now;
        return false;
    }

    _onPlayPause() {
        if (this._proxy && !this._isControlThrottled()) {
            this._proxy.PlayPauseRemote();
        }
    }

    _onNext() {
        if (this._proxy && !this._isControlThrottled()) {
            this._proxy.NextRemote();
        }
    }

    _onPrevious() {
        if (this._proxy && !this._isControlThrottled()) {
            this._proxy.PreviousRemote();
        }
    }

    _startProgressTimer() {
        if (this._progressTimerId) return;
        this._updateProgress();
        this._progressTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._updateProgress();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopProgressTimer() {
        if (this._progressTimerId) {
            GLib.source_remove(this._progressTimerId);
            this._progressTimerId = null;
        }
    }

    _updateProgress() {
        if (!this._proxy || !this._trackLength || this._trackLength <= 0) {
            this._progressFraction = 0;
        } else {
            try {
                const pos = Number(this._proxy.Position);
                this._progressFraction = Math.min(1, Math.max(0, pos / this._trackLength));
            } catch (e) {
                this._progressFraction = 0;
            }
        }
        this._progressDraw?.queue_repaint();
    }

    _drawProgress(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const fraction = this._progressFraction || 0;

        const lw = 2.5;
        const r = 4;
        const inset = lw / 2;

        const straightH = w - 2 * r - 2 * inset;
        const straightV = h - 2 * r - 2 * inset;
        const cornerArc = (Math.PI / 2) * r;
        const totalPerimeter = 2 * straightH + 2 * straightV + 4 * cornerArc;

        // Trace rounded rect path starting from top-center, clockwise
        const tracePath = () => {
            cr.newPath();
            cr.moveTo(w / 2, inset);
            cr.lineTo(w - r - inset, inset);
            cr.arc(w - r - inset, r + inset, r, -Math.PI / 2, 0);
            cr.lineTo(w - inset, h - r - inset);
            cr.arc(w - r - inset, h - r - inset, r, 0, Math.PI / 2);
            cr.lineTo(r + inset, h - inset);
            cr.arc(r + inset, h - r - inset, r, Math.PI / 2, Math.PI);
            cr.lineTo(inset, r + inset);
            cr.arc(r + inset, r + inset, r, Math.PI, 3 * Math.PI / 2);
            cr.lineTo(w / 2, inset);
        };

        cr.setLineWidth(lw);
        cr.setLineCap(1); // ROUND

        // Background track (full perimeter, very faint)
        tracePath();
        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setDash([], 0);
        cr.stroke();

        // Progress line
        if (fraction > 0) {
            const progressLen = fraction * totalPerimeter;
            tracePath();
            cr.setSourceRGBA(1, 1, 1, 0.6);
            cr.setDash([progressLen, totalPerimeter], 0);
            cr.stroke();
        }

        cr.$dispose();
    }

    _fetchWaveform() {
        if (!this._zonesProxy) return;
        this._zonesProxy.GetWaveformRemote((result, error) => {
            if (error || !result || !result[0]) {
                this._waveformData = null;
                return;
            }
            try {
                this._waveformData = JSON.parse(result[0]);
            } catch (e) {
                this._waveformData = null;
            }
        });
    }

    _startVUTimer() {
        if (this._vuTimerId) return;
        this._vuTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._updateVU();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopVUTimer() {
        if (this._vuTimerId) {
            GLib.source_remove(this._vuTimerId);
            this._vuTimerId = null;
        }
        // Fade bars to zero
        this._vuBars.fill(0);
        this._vuDraw?.queue_repaint();
    }

    _updateVU() {
        if (!this._waveformData || !this._waveformData.length ||
            !this._proxy || !this._trackLength || this._trackLength <= 0) {
            this._vuBars.fill(0);
            this._vuDraw?.queue_repaint();
            return;
        }

        const pos = Number(this._proxy.Position);
        const fraction = Math.min(1, Math.max(0, pos / this._trackLength));
        const centerIdx = Math.floor(fraction * this._waveformData.length);
        const numBars = this._vuBars.length;

        for (let i = 0; i < numBars; i++) {
            // Sample at slightly different offsets around current position
            const offset = (i - numBars / 2) * 3;
            const idx = Math.min(this._waveformData.length - 1,
                Math.max(0, centerIdx + Math.round(offset)));
            let target = this._waveformData[idx] || 0;

            // Add random variation for liveliness
            target *= 0.7 + Math.random() * 0.6;
            target = Math.min(1, target);

            // Exponential smoothing — fast attack, slow decay
            const prev = this._vuBars[i];
            this._vuBars[i] = target > prev
                ? target * 0.6 + prev * 0.4   // fast attack
                : target * 0.2 + prev * 0.8;  // slow decay
        }

        this._vuDraw?.queue_repaint();
    }

    _drawVUMeters(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const numBars = this._vuBars.length;
        const barSpacing = 6;
        const barWidth = 16;
        const totalWidth = numBars * barWidth + (numBars - 1) * barSpacing;
        const startX = (w - totalWidth) / 2;
        const r = 2; // rounded corners

        for (let i = 0; i < numBars; i++) {
            const x = startX + i * (barWidth + barSpacing);
            const value = this._vuBars[i] || 0;
            const barH = Math.max(2, value * (h - 4));
            const y = h - 2 - barH;

            // Background slot
            cr.setSourceRGBA(1, 1, 1, 0.06);
            this._roundedRect(cr, x, 2, barWidth, h - 4, r);
            cr.fill();

            // Active bar
            if (value > 0.01) {
                const alpha = 0.3 + value * 0.4;
                cr.setSourceRGBA(1, 1, 1, alpha);
                this._roundedRect(cr, x, y, barWidth, barH, r);
                cr.fill();
            }
        }

        cr.$dispose();
    }

    _roundedRect(cr, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        cr.newPath();
        cr.moveTo(x + r, y);
        cr.lineTo(x + w - r, y);
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.lineTo(x + w, y + h - r);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.lineTo(x + r, y + h);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.lineTo(x, y + r);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    }

    destroy() {
        this._stopVUTimer();
        this._stopProgressTimer();
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
