/**
 * Content Script - 扫描页面中的视频资源
 * 运行在目标网页中，收集视频URL后发送给popup
 */

(function () {
  const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|avi|mov|mkv|flv|wmv|m3u8|mpd|ts)(\?.*)?$/i;
  const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/x-msvideo',
    'video/quicktime', 'video/x-matroska', 'application/x-mpegURL',
    'application/vnd.apple.mpegurl', 'application/dash+xml'];

  /**
   * 获取文件名（从URL中提取）
   */
  function getFilename(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      const name = parts[parts.length - 1];
      return name && name.length > 0 ? decodeURIComponent(name) : u.hostname + '_video';
    } catch {
      return 'video';
    }
  }

  /**
   * 格式化文件大小
   */
  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '未知大小';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * 判断是否是视频URL
   */
  function isVideoUrl(url) {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) {
      // blob URL 可能是视频，也可能不是，先保留blob
      return url && url.startsWith('blob:');
    }
    return VIDEO_EXTENSIONS.test(url);
  }

  /**
   * 从DOM中扫描视频元素
   */
  function scanDomVideos() {
    const videos = [];
    const seen = new Set();

    function addVideo(url, title, type, sourceEl) {
      if (!url || seen.has(url)) return;
      seen.add(url);

      let size = '未知大小';
      // 尝试从dataset或属性中获取大小信息
      if (sourceEl && sourceEl.dataset && sourceEl.dataset.size) {
        size = formatSize(parseInt(sourceEl.dataset.size));
      }

      videos.push({
        url,
        filename: getFilename(url),
        title: title || document.title || '未知视频',
        type: type || '视频',
        size,
        isBlob: url.startsWith('blob:'),
        isHLS: url.includes('.m3u8') || url.includes('m3u8'),
        isDASH: url.includes('.mpd') || url.includes('mpd'),
      });
    }

    // 1. 扫描 <video> 标签
    document.querySelectorAll('video').forEach((video) => {
      const src = video.src || video.currentSrc;
      if (src) addVideo(src, video.title || video.getAttribute('alt'), '直接视频', video);

      // <video> 内的 <source>
      video.querySelectorAll('source').forEach((source) => {
        if (source.src) addVideo(source.src, video.title, source.type || '视频源', source);
      });
    });

    // 2. 扫描 <source> 标签（独立的）
    document.querySelectorAll('source[src]').forEach((source) => {
      const mime = source.type || '';
      if (isVideoUrl(source.src) || VIDEO_MIME_TYPES.some(m => mime.includes(m))) {
        addVideo(source.src, '视频源', source.type, source);
      }
    });

    // 3. 扫描 <a> 链接中指向视频文件的链接
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      if (isVideoUrl(href)) {
        addVideo(href, a.textContent.trim() || a.title || '链接视频', '链接下载', a);
      }
    });

    // 4. 扫描 <iframe> 中可能的视频源（只看src属性）
    document.querySelectorAll('iframe[src]').forEach((iframe) => {
      const src = iframe.src;
      if (isVideoUrl(src)) {
        addVideo(src, iframe.title || '嵌入视频', '嵌入视频', iframe);
      }
    });

    return videos;
  }

  /**
   * 从页面脚本/JSON数据中提取视频URL
   */
  function scanScriptVideos() {
    const videos = [];
    const seen = new Set();
    const urlPattern = /(https?:\/\/[^\s"'<>]+\.(mp4|webm|ogg|avi|mov|mkv|flv|wmv|m3u8|mpd|ts)(\?[^\s"'<>]*)?)/gi;

    document.querySelectorAll('script:not([src])').forEach((script) => {
      const content = script.textContent;
      let match;
      while ((match = urlPattern.exec(content)) !== null) {
        const url = match[1];
        if (!seen.has(url)) {
          seen.add(url);
          videos.push({
            url,
            filename: getFilename(url),
            title: '页面脚本中的视频',
            type: match[2].toUpperCase(),
            size: '未知大小',
            isBlob: false,
            isHLS: url.includes('.m3u8'),
            isDASH: url.includes('.mpd'),
          });
        }
      }
    });

    return videos;
  }

  /**
   * 主函数：收集所有视频资源
   */
  function collectVideos() {
    const domVideos = scanDomVideos();
    const scriptVideos = scanScriptVideos();

    // 合并，去重（以URL为key）
    const allUrls = new Set(domVideos.map(v => v.url));
    const merged = [...domVideos];

    scriptVideos.forEach(v => {
      if (!allUrls.has(v.url)) {
        allUrls.add(v.url);
        merged.push(v);
      }
    });

    return merged;
  }

  // 监听来自popup或background的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getVideos') {
      const videos = collectVideos();
      sendResponse({ videos, pageTitle: document.title, pageUrl: location.href });
    }
    return true; // 保持异步通道
  });

  // 页面加载完成后，将拦截到的网络请求视频通知给background
  // 这部分由background.js的webRequest负责
})();
