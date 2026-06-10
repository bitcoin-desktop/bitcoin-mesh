// The wire log: a window into the invisible. Renders protocol events —
// signaling, wire messages, validation verdicts, serving — as they happen.

const KINDS = {
  out: { mark: '→', cls: 'out' },   // we sent something
  in: { mark: '←', cls: 'in' },     // something arrived
  ok: { mark: '✓', cls: 'ok' },     // verified / succeeded
  bad: { mark: '✗', cls: 'bad' },   // rejected / failed
  note: { mark: '·', cls: 'note' }, // lifecycle
};

export function createWireLog(container, { max = 250 } = {}) {
  container.classList.add('wirelog');

  function line(kind, text) {
    const k = KINDS[kind] ?? KINDS.note;
    const el = document.createElement('div');
    el.className = `wl ${k.cls}`;
    const t = new Date().toTimeString().slice(0, 8);
    el.innerHTML = `<span class="t">${t}</span> <span class="m">${k.mark}</span> ${text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')}`;
    container.appendChild(el);
    while (container.children.length > max) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }

  // Wrap any LightNode source (esplora, bridge, peer) so its conversation
  // shows in the log — without touching the schema package.
  function wrapSource(source, label) {
    return new Proxy(source, {
      get(target, prop) {
        const v = target[prop];
        if (prop === 'headersAfter') {
          return async (tipHash) => {
            line('out', `${label}: getheaders (locator ${tipHash.slice(0, 16)}…)`);
            const headers = await v.call(target, tipHash);
            line('in', `${label}: headers ×${headers.length.toLocaleString()}`);
            return headers;
          };
        }
        if (prop === 'headersRange') {
          return async (start, count) => {
            line('out', `${label}: GET headers ${start.toLocaleString()}…${(start + count - 1).toLocaleString()}`);
            const headers = await v.call(target, start, count);
            line('in', `${label}: ${headers.length.toLocaleString()} headers (reconstructed, self-verified)`);
            return headers;
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  // Standard rendering for MeshSwarm events.
  function meshEvent(type, detail = {}) {
    switch (type) {
      case 'connecting': return line('out', `signaling: connecting to ${detail.url}`);
      case 'signaling-open': return line('ok', 'signaling connected');
      case 'gathering': return line('note', `gathering ICE for offer ${detail.i}/${detail.n}… (can take a few seconds)`);
      case 'waiting': return line('note', 'no peers yet — staying announced; open this page elsewhere to connect');
      case 'keepalive': return line('note', 'keepalive ping (staying in the swarm)');
      case 'signaling-lost': return line('bad', `signaling connection lost — reconnecting (attempt ${detail.attempt})…`);
      case 'signaling-restored': return line('ok', 'signaling restored — re-announced');
      case 'announce': return line('out', `swarm: announce ×${detail.offers} offers (resource ${detail.resource.slice(0, 12)}…)`);
      case 'swarm-peers': return line('in', `swarm: ${detail.count} peer${detail.count === 1 ? '' : 's'} seen by tracker`);
      case 'offer-in': return line('in', 'swarm: offer from a peer — answering');
      case 'answer-in': return line('in', 'swarm: a peer took one of our offers');
      case 'peer-open': return line('ok', 'data channel OPEN — direct browser↔browser');
      case 'peer-close': return line('note', 'data channel closed');
      case 'served': return line('out', `served headers ×${detail.count.toLocaleString()} to a peer (total ${detail.total.toLocaleString()})`);
      case 'wire-in': return line('in', `peer: ${detail.command}${detail.size ? ` (${detail.size.toLocaleString()} bytes)` : ''}`);
      case 'wire-out': return line('out', `peer: ${detail.command}`);
      default: return line('note', `${type} ${JSON.stringify(detail)}`);
    }
  }

  return { line, wrapSource, meshEvent };
}

export const WIRELOG_CSS = `
  .wirelog { background: #0d1117; border-radius: 8px; padding: .6rem .8rem; margin-top: .8rem;
             height: 14rem; overflow-y: auto; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .wirelog .wl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #e6edf3; }
  .wirelog .t { color: #57606a; }
  .wirelog .m { display: inline-block; width: 1em; text-align: center; }
  .wirelog .out .m, .wirelog .out { color: #e8830c; }
  .wirelog .in .m, .wirelog .in { color: #58a6ff; }
  .wirelog .ok .m, .wirelog .ok { color: #3fb950; }
  .wirelog .bad .m, .wirelog .bad { color: #f85149; font-weight: 600; }
  .wirelog .note { color: #8b949e; }
`;
