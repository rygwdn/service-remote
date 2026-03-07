import { EventEmitter } from 'events';

declare module 'node-osc' {
  class Client extends EventEmitter {
    constructor(host: string, port: number);
    host: string;
    port: number;
    close(cb?: Function): Promise<void> | undefined;
    send(...args: any[]): Promise<void> | undefined;
  }

  class Server extends EventEmitter {
    constructor(port: number, host?: string, cb?: Function);
    port: number;
    host: string;
    close(cb?: Function): Promise<void> | undefined;
    on(event: 'message', listener: (msg: unknown[]) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  class Message {
    constructor(address: string, ...args: any[]);
    oscType: 'message';
    address: string;
    args: any[];
    append(arg: any): void;
  }

  interface OscDecodedMessage {
    oscType: 'message';
    address: string;
    args: { value: unknown }[];
  }

  function encode(message: Message): Buffer;
  function decode(buffer: Buffer): OscDecodedMessage;

  export { Client, Server, Message, encode, decode };
}
