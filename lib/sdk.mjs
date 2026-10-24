// NDJSON JSON-RPC for the dsh sdk profile. One transport belongs to one job.
import { StringDecoder } from 'node:string_decoder';

export class SdkPeer {
  constructor(child, onMessage = () => {}, onFailure = () => {}) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.onMessage = onMessage;
    this.onFailure = onFailure;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', chunk => {
      if (this.closed) return;
      try {
        buffer += decoder.write(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('SDK record exceeds 8 MiB');
          if (line.trim()) this.receive(JSON.parse(line));
        }
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error('SDK record exceeds 8 MiB');
      } catch (error) { this.fail(error); }
    });
    child.stdout.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.once('error', error => this.fail(error));
    child.once('close', () => this.fail(new Error('dsh SDK process closed')));
  }

  receive(message) {
    if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid dsh SDK JSON-RPC record');
    if (typeof message.method === 'string') { this.onMessage(message); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`SDK ${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
    else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('SDK response has neither result nor error'));
  }

  send(message) {
    if (this.closed) throw new Error('SDK transport is closed');
    const line = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('SDK request exceeds 8 MiB');
    this.child.stdin.write(line);
  }

  request(method, params, timeoutMs) {
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many pending SDK requests'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`SDK ${method} timed out`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  respond(id, result) { this.send({ id, result }); }
  reject(id, message) { this.send({ id, error: { code: -32601, message } }); }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.onFailure(error);
  }
}
