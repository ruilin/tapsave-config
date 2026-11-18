// Opt-in adapter: observe the site's own Hls player after it has parsed its responses.
// No requests, player controls, DRM hooks or automatic downloads are added here.
(() => {
  if (location.protocol !== 'https:' || !/^(?:www|m)\.imooc\.com$/.test(location.hostname) || window.__imoocCaptureInstalled) return;
  window.__imoocCaptureInstalled = true;
  const LIMIT = 262144, players = new WeakMap(), patched = new WeakSet();
  const https = value => { try { return typeof value === 'string' && new URL(value, location.href).protocol === 'https:'; } catch (_) { return false; } };
  // The older mobile player exposes parsed fragments, but does not retain the original m3u8 text.
  // Rebuild only its simple, complete TS layout; reject maps, ranges and discontinuities.
  const playlistText = details => {
    if (typeof details.m3u8 === 'string') return details.m3u8;
    const fragments = details.fragments;
    if (details.live !== false || details.initSegment || details.needSidxRanges || details.skippedSegments || !Array.isArray(fragments) || !fragments.length || fragments.length > 10000 || !Number.isSafeInteger(details.startSN) || details.startSN < 0) return '';
    const quote = value => {
      if (!https(value) || /["\r\n]/.test(value)) throw Error('Invalid URI');
      return '"' + value + '"';
    };
    const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    let text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...fragments.map(f => f.duration))) + '\n#EXT-X-MEDIA-SEQUENCE:' + details.startSN + '\n', previousKey = 'NONE';
    for (let i = 0; i < fragments.length; i++) {
      const frag = fragments[i];
      if (!Number.isSafeInteger(frag.sn) || frag.sn !== details.startSN + i || frag.cc !== fragments[0].cc || frag.gap || frag.initSegment || (frag.byteRange && frag.byteRange.length) || !Number.isFinite(frag.duration) || frag.duration <= 0) return '';
      const key = frag.decryptdata;
      let line = 'NONE';
      if (key && key.method && key.method !== 'NONE') {
        if (key.method !== 'AES-128' || (key.keyFormat && key.keyFormat !== 'identity')) return '';
        line = 'AES-128,URI=' + quote(key.uri);
        if (key.iv) {
          const iv = new Uint8Array(key.iv);
          if (iv.length !== 16) return '';
          const expected = new Uint8Array(16);
          let sequence = frag.sn;
          for (let n = 15; n >= 0; n--) { expected[n] = sequence % 256; sequence = Math.floor(sequence / 256); }
          if (hex(iv) !== hex(expected)) line += ',IV=0x' + hex(iv);
        }
      }
      if (line !== previousKey) { text += '#EXT-X-KEY:METHOD=' + line + '\n'; previousKey = line; }
      quote(frag.url); // Validate the already-resolved URL before putting it on its own line.
      text += '#EXTINF:' + frag.duration + ',\n' + frag.url + '\n';
      if (text.length > LIMIT) return '';
    }
    return text + '#EXT-X-ENDLIST\n';
  };
  const publish = state => {
    const {url, playlist} = state;
    if (!url || !playlist || !playlist.includes('#EXT-X-ENDLIST')) return;
    const keys = {}, pattern = /^#EXT-X-KEY:([^\r\n]+)$/gm;
    let match;
    while ((match = pattern.exec(playlist))) {
      const attrs = match[1];
      if (/\bMETHOD=NONE(?:,|$)/.test(attrs)) continue;
      if (!/\bMETHOD=AES-128(?:,|$)/.test(attrs) || /\bKEYFORMAT="(?!identity")/.test(attrs)) return;
      const uri = /(?:^|,)URI="([^"]+)"/.exec(attrs);
      if (!uri) return;
      const address = new URL(uri[1], url).href;
      if (!state.keys.has(address)) return; // Wait until the player has loaded every required key.
      keys[address] = state.keys.get(address);
    }
    const signature = JSON.stringify([url, playlist, keys]);
    if (signature === state.sent) return;
    window.SnifferBridge.postMessage(JSON.stringify({type: 'imooc_hls', url, playlist, keys, page: location.href}));
    state.sent = signature;
  };
  const patch = Hls => {
    if (!Hls || !Hls.prototype || typeof Hls.prototype.trigger !== 'function' || patched.has(Hls)) return;
    patched.add(Hls);
    const trigger = Hls.prototype.trigger;
    Hls.prototype.trigger = function (event, data, ...rest) {
      try {
        let state = players.get(this);
        if (!state) { state = {keys: new Map()}; players.set(this, state); }
        if (event === Hls.Events.LEVEL_LOADED && data && data.details) {
          const details = data.details, url = details.url;
          let text = '';
          try { text = playlistText(details); } catch (_) {}
          if (typeof url === 'string' && https(url) && text.length <= LIMIT && text.startsWith('#EXTM3U')) {
            if (state.url && state.url !== url) state.keys.clear();
            state.url = url; state.playlist = text;
          } else { state.url = ''; state.playlist = ''; state.keys.clear(); }
        } else if (event === Hls.Events.KEY_LOADED && data && data.frag) {
          const decrypted = data.frag.decryptdata;
          if (decrypted && decrypted.method === 'AES-128' && https(decrypted.uri) && decrypted.key && decrypted.key.byteLength === 16 && (state.keys.has(decrypted.uri) || state.keys.size < 16)) {
            const bytes = new Uint8Array(decrypted.key);
            state.keys.set(decrypted.uri, Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''));
          }
        }
        publish(state);
      } catch (_) {} // Observation must never break playback.
      return trigger.call(this, event, data, ...rest);
    };
  };
  // The bundle assigns window.Hls before constructing its player; intercept that assignment synchronously.
  if (window.Hls) patch(window.Hls);
  else {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'Hls');
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(window, 'Hls', {configurable: true, enumerable: true, get: () => undefined, set(value) {
        Object.defineProperty(window, 'Hls', {value, configurable: true, enumerable: true, writable: true});
        patch(value);
      }});
    }
  }
})();
