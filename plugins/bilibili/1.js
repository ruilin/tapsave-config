// Opt-in Bilibili adapter. Observe only the current video's page data and playback responses.
(() => {
  if (location.protocol !== 'https:' || !/^(?:www\.|m\.)?bilibili\.com$/.test(location.hostname) || !/^\/video\/(?:BV[A-Za-z0-9]+|av\d+)\/?$/.test(location.pathname) || window.__biliCaptureInstalled) return;
  window.__biliCaptureInstalled = true;
  const LIMIT = 524288, sent = new Set();
  let lastPage = location.href;
  const urlOf = item => {
    const candidates = [item.baseUrl, item.base_url, item.url, ...(item.backupUrl || item.backup_url || [])];
    for (const raw of candidates) {
      try {
        if (typeof raw !== 'string' || raw.length > 8192) continue;
        const u = new URL(raw, location.href);
        if (u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && /(?:^|\.)(?:bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(u.hostname)) return u.href;
      } catch (_) {}
    }
    return '';
  };
  const metadata = () => {
    const state = window.__INITIAL_STATE__ || {}, mobile = state.video || {};
    const view = mobile.viewInfo || state.videoData || {};
    const current = location.pathname.split('/')[2];
    if (current.startsWith('BV') && view.bvid && view.bvid !== current) return null;
    const part = Number(new URL(location.href).searchParams.get('p') || 1);
    if (mobile.p && Number(mobile.p) !== part) return null;
    return {mobile, view, title: String(view.title || document.title || '').slice(0, 200), cover: String(view.pic || '').replace(/^\/\//, 'https://')};
  };
  const heightFor = quality => ({16:360,32:480,64:720,74:720,80:1080,112:1080,116:1080,120:2160,125:1080,126:2160,127:4320}[quality] || 0);
  const inspect = (packet, responseUrl = '') => {
    try {
      if (location.href !== lastPage) { sent.clear(); lastPage = location.href; }
      const meta = metadata();if (!meta || !packet || (packet.code !== undefined && packet.code !== 0)) return;
      if (responseUrl) {
        const cid = new URL(responseUrl).searchParams.get('cid');
        if (!meta.view.cid || !cid || String(meta.view.cid) !== cid) return; // Ignore next-video preloads.
      }
      const data = packet.data || packet.result || packet;
      if (data.is_drm || data.drm_tech_type || data.drm_info || data.dash?.drm) return;
      const formats = [], add = (entry, kind, height = 0) => {
        const url = urlOf(entry);if (!url || formats.some(f => f.url === url) || formats.length >= 32) return;
        const codec = String(entry.codecs || '');if (!/^[A-Za-z0-9.,_-]{0,100}$/.test(codec)) return;
        formats.push({url,kind,height:Number(height)||0,bandwidth:Number(entry.bandwidth)||0,codec});
      };
      if (data.dash) {
        for (const entry of (data.dash.video || []).slice(0,24)) if (!(entry.mimeType || entry.mime_type) || (entry.mimeType || entry.mime_type) === 'video/mp4') add(entry,'video',entry.height);
        for (const entry of (data.dash.audio || []).slice(0,8)) if (!(entry.mimeType || entry.mime_type) || (entry.mimeType || entry.mime_type) === 'audio/mp4') add(entry,'audio');
        if (!formats.some(f=>f.kind==='video') || !formats.some(f=>f.kind==='audio')) return;
      } else if (Array.isArray(data.durl) && data.durl.length === 1) add(data.durl[0],'combined',heightFor(data.quality));
      else return; // Multi-part durl needs a separate concatenation implementation; never truncate it.
      if (!formats.length) return;
      const payload = JSON.stringify({type:'bili_media',page:location.href,title:meta.title,cover:meta.cover,formats});
      if (payload.length > 262144 || sent.has(payload) || sent.size >= 24) return;
      window.SnifferBridge.postMessage(payload);sent.add(payload);
    } catch (_) {}
  };
  const scan = () => {
    try {
      const meta = metadata();if (!meta) return;
      if (window.__playinfo__) inspect(window.__playinfo__);
      if (Array.isArray(meta.mobile.playUrlInfo)) inspect({durl:meta.mobile.playUrlInfo,quality:meta.mobile.streamQuality});
    } catch (_) {}
  };
  const playback = raw => {
    try {const u=new URL(raw);return /^(?:api\.bilibili\.com|api\.biliapi\.net)$/.test(u.hostname) && /^\/x\/player\/(?:wbi\/)?playurl\/?$/.test(u.pathname);}catch(_){return false;}
  };
  const observe = async response => {
    if (!playback(response.url) || Number(response.headers.get('content-length')) > LIMIT || !response.body) return;
    const reader = response.clone().body.getReader(), chunks=[];let size=0;
    const timer=setTimeout(()=>reader.cancel().catch(()=>{}),5000);
    try {
      while (true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>LIMIT){reader.cancel().catch(()=>{});return;}chunks.push(value);}
      const all=new Uint8Array(size);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.length;}
      inspect(JSON.parse(new TextDecoder().decode(all)),response.url);
    } finally {clearTimeout(timer);reader.releaseLock();}
  };
  const fetch = window.fetch;
  window.fetch = function(...args){return fetch.apply(this,args).then(response=>{observe(response).catch(()=>{});return response;});};
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args){
    this.addEventListener('load',()=>{try {
      if (!playback(this.responseURL)) return;
      if (this.responseType==='json') inspect(this.response,this.responseURL);
      else if ((!this.responseType || this.responseType==='text') && this.responseText.length<=LIMIT) inspect(JSON.parse(this.responseText),this.responseURL);
    }catch(_){}},{once:true});return send.apply(this,args);
  };
  scan();let timer=setInterval(scan,1500);
  window.addEventListener('pagehide',()=>{clearInterval(timer);timer=null;});
  window.addEventListener('pageshow',()=>{sent.clear();scan();if(timer===null)timer=setInterval(scan,1500);});
})();
