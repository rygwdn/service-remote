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

  export { Client, Server };
}
