/* eslint-disable max-len */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { Telnet } from 'telnet-client';

import { HegelHomebridgePlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different power types.
 */
export class HegelPlatformAccessory {
    private speaker: Service;

    private HegelStates = {
        On: false,
        Mute: false,
        Volume: 0,
    };
    private connection = new Telnet();
    private connected = false;
    private queueInProcess = false;
    private commandQueue: HegelCommand[] = [];

    constructor(
        private readonly platform: HegelHomebridgePlatform,
        private readonly accessory: PlatformAccessory,
    ) {

        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hegel')
            .setCharacteristic(this.platform.Characteristic.Model, this.platform.config.model || 'H120')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.platform.config.serialNumber || 'unknown');

        this.platform.log.debug('Adding speaker service');
        this.speaker = this.accessory.getService('Speakers') || this.accessory.addService(this.platform.Service.Speaker, 'Speakers');
        this.speaker.setCharacteristic(this.platform.Characteristic.Name, (this.platform.config.name || 'Hegel') + ' Speakers');
        this.speaker.getCharacteristic(this.platform.Characteristic.On).onGet(this.getOn.bind(this)).onSet(this.setOn.bind(this));
        this.speaker.getCharacteristic(this.platform.Characteristic.Mute)
            .onGet(this.handleMuteGet.bind(this))
            .onSet(this.handleMuteSet.bind(this));

    }

    async setOn(value: CharacteristicValue) {
        this.HegelStates.On = value as boolean;
        if (value as boolean) {
            this.sendTo({ type: 'p', value: '1' });
        } else {
            this.sendTo({ type: 'p', value: '0' });
        }
    }

    async getOn() {
        const isOn = this.HegelStates.On;
        if (this.commandQueue.some(x => x.type === 'p' && x.value === '?')) {
            this.platform.log.debug('Power query already queued', isOn);
        } else {
            this.sendTo({ type: 'p', value: '?' });
        }
        return isOn;
    }


    async handleMuteGet() {
        const currentValue = this.HegelStates.Mute;
        if (this.commandQueue.some(x => x.type === 'm' && x.value === '?')) {
            this.platform.log.debug('Mute query already queued', currentValue);
        } else {
            this.sendTo({ type: 'm', value: '?' });
            this.platform.log.debug('Triggered GET Mute', currentValue);
        }
        return currentValue;
    }

    async handleMuteSet(value) {
        this.HegelStates.Mute = value as boolean;
        if (value as boolean) {
            this.sendTo({ type: 'm', value: '1' });
        } else {
            this.sendTo({ type: 'm', value: '0' });
        }
        this.platform.log.debug('Triggered SET Mute:', value);
    }


    async sendTo(cmd: HegelCommand) {
        this.TrySendTo(cmd, 1);
    }

    async TrySendTo(cmd: HegelCommand, noOfTries: number) {
        this.commandQueue.push(cmd);

        if (!this.queueInProcess) {
            this.queueInProcess = true;
            try {
                await this.processQueue();
            } catch (error) {
                this.platform.log.error('queue error:', error);
                this.connection.destroy();
                this.connected = false;
                if (noOfTries < 5) {
                    this.queueInProcess = false;
                    await this.TrySendTo(cmd, noOfTries + 1);
                }
            } finally {
                this.queueInProcess = false;
            }
        }
    }

    async processQueue() {
        if (this.commandQueue.length === 0) {
            return;
        }
        await this.ConnectToHegel();
        if (this.connected) {
            while (this.commandQueue.length > 0) {
                const cmd = this.commandQueue[0]
                this.platform.log.debug('Sending: ', cmd);
                const res = await this.connection.send(`-${cmd.type}.${cmd.value}`);
                this.platform.log.debug('async result:', res);
                await this.HandleResponse(res);
                this.commandQueue.shift();
            }
        }
    }

    async ConnectToHegel() {
        if (this.connected) {
            return;
        }

        const params = {
            host: this.platform.config.ip,
            port: this.platform.config.port || 23,
            shellPrompt: 'Main.Model=' + this.platform.config.model,
            timeout: 1000,
        };

        this.platform.log.debug('connection to ', params.host);
        this.platform.log.debug('waiting for', params.shellPrompt);
        try {
            await this.connection.connect(params);
            this.connected = true;
        } catch (error) {
            this.platform.log.error('connection error', error);
            this.connected = false;
        }
    }

    async HandleResponse(value: string) {
        const cmd = parseHegelCommand(value)
        switch (cmd.type) {
            case 'p':
                if (cmd.value === '1') {
                    this.HegelStates.On = true;
                    this.speaker.updateCharacteristic(this.platform.Characteristic.On, true)
                } else {
                    this.HegelStates.On = false;
                    this.speaker.updateCharacteristic(this.platform.Characteristic.On, false)
                }
            case 'm':
                if (cmd.value === '1') {
                    this.HegelStates.Mute = true;
                    this.speaker.updateCharacteristic(this.platform.Characteristic.Mute, true);
                } else {
                    this.HegelStates.Mute = false;
                    this.speaker.updateCharacteristic(this.platform.Characteristic.Mute, false);
                }
            case 'invalid':
                this.platform.log.warn('Invalid Response Received:', cmd.value);
            default:
                this.platform.log.warn('Unknown Response Received:', cmd.value);
        }
    }
}

type HegelCommand =
    | { type: 'p'; value: string }
    | { type: 'i'; value: string }
    | { type: 'v'; value: string }
    | { type: 'm'; value: string }
    | { type: 'invalid'; value: string }

function parseHegelCommand(value: string): HegelCommand {
    if (!value.startsWith('-')) {
        return { type: 'invalid', value: value }
    }
    const parts = value.split('.')
    if (parts.length !== 2) {
        return { type: 'invalid', value: value }
    }
    const cmd: string = parts[0];
    const cmdValue: string = parts[1];

    switch (cmd) {
        case 'p':
            return { type: 'p', value: cmdValue }
        case 'i':
            return { type: 'i', value: cmdValue }
        case 'v':
            return { type: 'v', value: cmdValue }
        case 'm':
            return { type: 'm', value: cmdValue }
        default:
            return { type: 'invalid', value: value }
    }
}
