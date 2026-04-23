/**
 * Background Service Worker
 * 1. 拦截网络视频请求，存储在内存中
 * 2. 处理下载任务
 */

const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|avi|mov|mkv|flv|wmv|m3u8|mpd|ts)(\?.*)?$/i;
const VIDEO_MIME_PREFIXES = ['video/', 'application/x-mpegurl', 'application/vnd.apple.mpegurl',
  'application/dash+xml', 'application/octet-stream'];

// 按tabId存储拦截到的视频请求
const interceptedVideos = {};

/**
 * 判断是否是视频请求
 */
function isVideoRequest(details) {
  const url = details.url;
  // 跳过扩展自身请求、数据URL
  if (url.startsWith('chrome-extension://') || url.startsWith('data:')) return false;
  if (VIDEO_EXTENSIONS.test(url)) return true;

  // 通过响应头中的Content-Type判断（在onHeadersReceived中）
  return false;
}

/**
 * 从URL提取文件名
 */
function getFilename(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const name = parts[parts.length - 1] || 'video';
    return decodeURIComponent(name);
  } catch {
    return 'video.mp4';
  }
}

// 监听网络请求（在请求发送前记录URL）
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.tabId || details.tabId < 0) return;
    if (!isVideoRequest(details)) return;

    const tabId = details.tabId;
    if (!interceptedVideos[tabId]) interceptedVideos[tabId] = {};

    const url = details.url;
    if (!interceptedVideos[tabId][url]) {
      interceptedVideos[tabId][url] = {
        url,
        filename: getFilename(url),
        title: '网络拦截视频',
        type: '网络请求',
        size: '未知大小',
        isBlob: false,
        isHLS: url.includes('.m3u8'),
        isDASH: url.includes('.mpd'),
        timestamp: Date.now(),
      };
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// 从响应头中获取Content-Type，补充检测视频类型和大小
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!details.tabId || details.tabId < 0) return;

    const contentType = (details.responseHeaders || [])
      .find(h => h.name.toLowerCase() === 'content-type');
    const contentLength = (details.responseHeaders || [])
      .find(h => h.name.toLowerCase() === 'content-length');

    const mime = contentType ? contentType.value.toLowerCase() : '';
    const isVideo = VIDEO_MIME_PREFIXES.some(p => mime.startsWith(p)) ||
      VIDEO_EXTENSIONS.test(details.url);

    if (!isVideo) return;

    const tabId = details.tabId;
    if (!interceptedVideos[tabId]) interceptedVideos[tabId] = {};

    const url = details.url;
    const existing = interceptedVideos[tabId][url];

    // 格式化大小
    let size = '未知大小';
    if (contentLength && contentLength.value) {
      const bytes = parseInt(contentLength.value);
      if (bytes > 0) {
        if (bytes < 1024 * 1024) size = (bytes / 1024).toFixed(1) + ' KB';
        else size = (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      }
    }

    if (existing) {
      existing.size = size;
      existing.mimeType = mime;
    } else {
      interceptedVideos[tabId][url] = {
        url,
        filename: getFilename(url),
        title: '网络拦截视频',
        type: mime || '视频',
        size,
        mimeType: mime,
        isBlob: false,
        isHLS: url.includes('.m3u8'),
        isDASH: url.includes('.mpd'),
        timestamp: Date.now(),
      };
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Tab关闭时清理数据
chrome.tabs.onRemoved.addListener((tabId) => {
  delete interceptedVideos[tabId];
});

// Tab导航时清理旧数据
chrome.webNavigation && chrome.webNavigation.onBeforeNavigate &&
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) {
      delete interceptedVideos[details.tabId];
    }
  });

// 处理来自popup的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // 获取拦截到的视频列表
  if (message.action === 'getInterceptedVideos') {
    const tabId = message.tabId;
    const videos = Object.values(interceptedVideos[tabId] || {});
    // 最多返回最近100个，按时间倒序
    videos.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    sendResponse({ videos: videos.slice(0, 100) });
    return true;
  }

  // 下载视频
  if (message.action === 'downloadVideo') {
    const { url, filename, savePath, saveAs } = message;

    // 构建保存路径：savePath是子文件夹名（在Downloads下）
    let targetFilename = filename || getFilename(url);
    if (savePath && savePath.trim()) {
      // 清理路径，只允许相对路径（子文件夹）
      const cleanPath = savePath.trim()
        .replace(/^[/\\]+/, '')  // 去掉开头的斜杠
        .replace(/\.\./g, '')    // 防止路径穿越
        .replace(/[<>:"|?*]/g, ''); // 去掉非法字符

      if (cleanPath) {
        targetFilename = cleanPath + '/' + targetFilename;
      }
    }

    chrome.downloads.download(
      {
        url,
        filename: targetFilename,
        saveAs: !!saveAs,  // true则弹出另存为对话框
        conflictAction: 'uniquify',
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true; // 保持异步
  }

  // 获取存储的用户偏好（下载路径等）
  if (message.action === 'getSettings') {
    chrome.storage.local.get(['savePath', 'saveAs'], (result) => {
      sendResponse(result);
    });
    return true;
  }

  // 保存用户偏好
  if (message.action === 'saveSettings') {
    chrome.storage.local.set(message.settings, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
