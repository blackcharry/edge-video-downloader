/**
 * Popup Script
 */

let currentTabId = null;
let settings = { savePath: '' };

// ===== Toast 提示 =====
function showToast(msg, duration = 2000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ===== 获取当前Tab =====
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ===== 获取当前tab拦截到的网络视频 =====
async function fetchInterceptedVideos(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getInterceptedVideos', tabId },
      (response) => resolve(response?.videos || [])
    );
  });
}

// ===== 获取DOM中检测到的视频 =====
async function fetchDomVideos(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'getVideos' }, (response) => {
      resolve(response?.videos || []);
    });
  });
}

// ===== 获取设置 =====
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (result) => {
      resolve(result || {});
    });
  });
}

// ===== 保存设置 =====
async function saveSettings(settingsObj) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'saveSettings', settings: settingsObj },
      () => resolve()
    );
  });
}

// ===== 下载视频 =====
function downloadVideo(url, filename) {
  const savePath = settings.savePath || '';
  const pathHint = savePath ? ` (到 ${savePath}/)` : '';

  chrome.runtime.sendMessage(
    { action: 'downloadVideo', url, filename, savePath, saveAs: false },
    (response) => {
      if (response?.success) {
        showToast(`✅ 下载开始${pathHint}: ${filename}`);
      } else {
        showToast(`❌ 下载失败: ${response?.error || '未知错误'}`, 3000);
      }
    }
  );
}

// ===== 复制URL =====
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('📋 链接已复制');
  }).catch(() => {
    showToast('❌ 复制失败', 2000);
  });
}

// ===== HTML转义 =====
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== 渲染视频列表 =====
function renderVideoList(domVideos, netVideos) {
  const listEl = document.getElementById('videoList');
  const statsEl = document.getElementById('stats');

  // 合并两个列表，以URL去重
  const seen = new Map(); // url -> video
  [...domVideos, ...netVideos].forEach(v => {
    if (!seen.has(v.url)) seen.set(v.url, v);
  });

  const allVideos = Array.from(seen.values());

  if (allVideos.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">🎥</div>
        <p>未检测到视频资源</p>
        <p style="margin-top:6px;color:#444">可能视频通过JS动态加载，尝试播放后再检测</p>
      </div>
    `;
    statsEl.textContent = '共 0 个视频';
    return;
  }

  // 排序：非blob的排前面（可直接下载的），然后按文件名/URL排序
  allVideos.sort((a, b) => {
    if (a.isBlob !== b.isBlob) return a.isBlob ? 1 : -1;
    return a.filename.localeCompare(b.filename);
  });

  statsEl.textContent = `共 ${allVideos.length} 个视频`;

  let html = '';

  // DOM 视频 section
  const domOnly = allVideos.filter(v => !netVideos.find(n => n.url === v.url));
  const netOnly = allVideos.filter(v => !domVideos.find(d => d.url === v.url));

  if (domOnly.length > 0) {
    html += '<div class="section-title">⏱ DOM 检测到的视频</div>';
    domOnly.forEach((v, i) => {
      html += renderVideoItem(v, i, 'dom');
    });
  }

  if (netOnly.length > 0) {
    html += '<div class="section-title">🌐 网络拦截的视频</div>';
    netOnly.forEach((v, i) => {
      html += renderVideoItem(v, i, 'net');
    });
  }

  listEl.innerHTML = html;

  // 绑定下载按钮事件
  listEl.querySelectorAll('.btn-download').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.url;
      const filename = btn.dataset.filename;
      downloadVideo(url, filename);
    });
  });

  // 绑定复制按钮事件
  listEl.querySelectorAll('.btn-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      copyToClipboard(btn.dataset.url);
    });
  });
}

function renderVideoItem(v, idx, source) {
  const isPlayable = !v.isBlob && !v.isHLS && !v.isDASH;
  const icon = v.isHLS ? '📡' : v.isDASH ? '⚡' : v.isBlob ? '🔒' : '🎬';
  const extraTags = [];
  if (v.isHLS) extraTags.push('<span class="hls-tag">HLS</span>');
  if (v.isDASH) extraTags.push('<span class="hls-tag">DASH</span>');
  if (v.isBlob) extraTags.push('<span class="type-tag">Blob</span>');
  const typeTag = v.type ? `<span class="type-tag">${v.type}</span>` : '';

  return `
    <div class="video-item">
      <div class="video-icon">${icon}</div>
      <div class="video-info">
        <div class="video-name" title="${escapeHtml(v.url)}">${escapeHtml(v.filename)}</div>
        <div class="video-meta">
          ${typeTag}
          ${extraTags.join('')}
          <span>${v.size}</span>
          <span>${source === 'dom' ? 'DOM' : '网络'}</span>
        </div>
      </div>
      <div class="video-actions">
        <button class="btn-copy" data-url="${escapeHtml(v.url)}" title="复制链接">复制</button>
        <button class="btn-download"
          data-url="${escapeHtml(v.url)}"
          data-filename="${escapeHtml(v.filename)}"
          ${!isPlayable ? 'disabled title="Blob/HLS/DASH 需要额外处理"' : ''}>
          ${isPlayable ? '下载' : '需处理'}
        </button>
      </div>
    </div>
  `;
}

// ===== 主加载流程 =====
async function loadVideos() {
  const listEl = document.getElementById('videoList');
  const pageInfoEl = document.getElementById('pageInfo');

  listEl.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>正在扫描页面视频资源...</p>
    </div>
  `;

  try {
    const tab = await getCurrentTab();
    if (!tab || !tab.id) {
      listEl.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><p>无法获取当前页面信息</p></div>';
      return;
    }

    currentTabId = tab.id;
    pageInfoEl.textContent = tab.title || tab.url;

    // 并行获取DOM视频和网络拦截视频
    const [domVideos, netVideos] = await Promise.all([
      fetchDomVideos(tab.id).catch(() => []),
      fetchInterceptedVideos(tab.id).catch(() => []),
    ]);

    renderVideoList(domVideos, netVideos);

  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>扫描失败: ${err.message}</p></div>`;
  }
}

// ===== 事件绑定 =====
document.getElementById('refreshBtn').addEventListener('click', loadVideos);

// ===== 选择保存目录（使用 File System Access API） =====
document.getElementById('selectDirBtn').addEventListener('click', async () => {
  try {
    // 使用 showDirectoryPicker 让用户在本地文件系统选择目录
    const dirHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'downloads'
    });

    // 保存目录路径引用
    const pathName = dirHandle.name;
    
    // 存储目录句柄信息（无法直接获取完整路径，存名称做标识）
    const displayPath = `Downloads/${pathName}`;
    document.getElementById('selectedPath').textContent = `📁 ${displayPath}`;
    document.getElementById('selectedPath').style.color = '#4da6ff';

    // 保存到 storage
    settings.savePath = pathName;
    await saveSettings({ savePath: pathName });
    showToast(`✅ 已选择: ${displayPath}`);

  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`❌ 选择失败: ${err.message}`, 3000);
    }
  }
});

// 初始化
(async () => {
  const loaded = await loadSettings();
  settings = loaded || { savePath: '' };
  
  // 显示当前路径
  if (settings.savePath) {
    document.getElementById('selectedPath').textContent = `📁 Downloads/${settings.savePath}`;
    document.getElementById('selectedPath').style.color = '#4da6ff';
  } else {
    document.getElementById('selectedPath').textContent = '未选择目录（默认: Downloads）';
  }

  await loadVideos();
})();
