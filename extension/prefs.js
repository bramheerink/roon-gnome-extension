import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class RoonPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // General page
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic'
        });
        window.add(generalPage);

        // Panel settings
        const panelGroup = new Adw.PreferencesGroup({ title: 'Panel' });
        generalPage.add(panelGroup);

        const maxLenRow = new Adw.SpinRow({
            title: 'Max Label Length',
            subtitle: 'Maximum characters in panel label',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 100,
                step_increment: 5,
                value: settings.get_int('label-max-length')
            })
        });
        maxLenRow.connect('notify::value', () => {
            settings.set_int('label-max-length', maxLenRow.get_value());
        });
        panelGroup.add(maxLenRow);

        const controlsRow = new Adw.SwitchRow({
            title: 'Show Controls in Panel',
            subtitle: 'Show play/pause and next buttons in the top bar'
        });
        settings.bind('show-controls-in-panel', controlsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(controlsRow);

        // Hotkey settings
        const hotkeyGroup = new Adw.PreferencesGroup({ title: 'Keyboard Shortcuts' });
        generalPage.add(hotkeyGroup);

        const hotkeyRow = new Adw.ActionRow({
            title: 'Toggle Play/Pause',
            subtitle: settings.get_strv('toggle-play-pause')[0] || 'Not set'
        });
        hotkeyGroup.add(hotkeyRow);

        // Zones page
        const zonesPage = new Adw.PreferencesPage({
            title: 'Zones',
            icon_name: 'audio-speakers-symbolic'
        });
        window.add(zonesPage);

        const zonesGroup = new Adw.PreferencesGroup({
            title: 'Visible Outputs',
            description: 'Select which outputs to show volume sliders for'
        });
        zonesPage.add(zonesGroup);

        this._loadOutputs(zonesGroup, settings);
    }

    _loadOutputs(group, settings) {
        try {
            const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
            const result = bus.call_sync(
                'org.mpris.MediaPlayer2.roon',
                '/org/roon/Zones',
                'org.roon.Zones',
                'GetOutputs',
                null,
                new GLib.VariantType('(a(sssds))'),
                Gio.DBusCallFlags.NONE,
                5000,
                null
            );

            const outputs = result.deepUnpack()[0];
            const hiddenIds = settings.get_strv('hidden-output-ids');

            for (const [outputId, outputName, zoneName] of outputs) {
                const row = new Adw.SwitchRow({
                    title: outputName,
                    subtitle: `Zone: ${zoneName}`
                });
                row.set_active(!hiddenIds.includes(outputId));
                row.connect('notify::active', () => {
                    let hidden = settings.get_strv('hidden-output-ids');
                    if (row.get_active()) {
                        hidden = hidden.filter(id => id !== outputId);
                    } else {
                        if (!hidden.includes(outputId)) hidden.push(outputId);
                    }
                    settings.set_strv('hidden-output-ids', hidden);
                });
                group.add(row);
            }
        } catch (e) {
            const infoRow = new Adw.ActionRow({
                title: 'Bridge not running',
                subtitle: 'Start the Roon bridge to configure zones'
            });
            group.add(infoRow);
        }
    }
}
