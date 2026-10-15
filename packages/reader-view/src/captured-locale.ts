import type { DisplayLanguage } from '../../storage/src/index';

// Only the captured Home chrome is translated. Reader content is never rewritten.
const labels: Record<string, string> = {
  'Home': '首页', 'Space': '空间', 'Scheduled': '定时任务', 'Plugins': '插件', 'Local avatar': '本地头像',
  'Explore': '探索', 'Projects': '项目', 'Recents': '最近', 'New chat': '新聊天',
  'Your dot': '个人工作区',
  'Search': '搜索', 'Toggle sidebar': '切换侧边栏', 'Share': '分享',
  'Ask ChatGPT': '询问 ChatGPT', 'Dictate': '语音输入', 'Start Voice': '开始语音',
  'Add files and more': '添加文件及其他内容', 'More': '更多',
  'Skip to content': '跳转到内容', 'You said:': '你说：', 'ChatGPT said:': 'ChatGPT 说：',
  'Copy message': '复制消息', 'Share prompt': '分享提问', 'Edit message': '编辑消息',
  'Latest response': '最新回复',
  'ChatGPT can make mistakes. Check important info.': 'ChatGPT 可能会出错。请核对重要信息。',
  'Copy': '复制', 'Copy table': '复制表格', 'Expand table': '展开表格',
  'Enable word wrap': '启用自动换行', 'Read aloud': '朗读',
  'Regenerate response': '重新生成', 'React': '回应', 'More actions': '更多操作',
  'Scroll to bottom': '滚动到底部', 'Attach photos or videos': '附加照片或视频',
  'Attach photos': '附加照片', 'Attach files': '附加文件',
  'Select ChatGPT model': '选择 ChatGPT 模型', 'Send': '发送'
};
const english = new Map(Object.entries(labels).map(([en, zh]) => [zh, en]));

export function applyCapturedHomeLanguage(root: HTMLElement, language: DisplayLanguage): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest('[data-fv-body],[data-fv-title],style,script')) continue;
    const original = node.textContent ?? '';
    const trimmed = original.trim();
    if (trimmed === 'Your dot' || trimmed === 'Your workspace' || trimmed === '个人工作区') {
      node.textContent = original.replace(trimmed, language === 'en' ? 'Your workspace' : '个人工作区');
      continue;
    }
    const en = labels[trimmed] ? trimmed : english.get(trimmed);
    if (en) node.textContent = original.replace(trimmed, language === 'en' ? en : labels[en]!);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[aria-label],[data-placeholder],[placeholder],[title]')) {
    if (element.closest('[data-fv-body],[data-fv-title]')) continue;
    for (const attribute of ['aria-label', 'data-placeholder', 'placeholder', 'title']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      if (value === 'Your dot' || value === 'Your workspace' || value === '个人工作区') {
        element.setAttribute(attribute, language === 'en' ? 'Your workspace' : '个人工作区');
        continue;
      }
      const en = labels[value] ? value : english.get(value);
      if (en) element.setAttribute(attribute, language === 'en' ? en : labels[en]!);
    }
  }
}

const controls: Record<string, string> = {
  '显示设置': 'Display settings', '收起操作面板': 'Close controls',
  '图片展示': 'Images', '禁止展示图片': 'Hide images', '展示缩略图': 'Show thumbnails', '全图展示': 'Show full images',
  '禁止模式仍可点击文字标记临时查看。原站可能已加载图片资源。': 'Hidden images can still be opened temporarily. The source site may have already loaded them.',
  '上一章': 'Previous chapter', '下一章': 'Next chapter', '上一段': 'Previous section', '下一段': 'Next section',
  '切换并定位到来源章节': 'Switch to source chapter', '定位到来源': 'Go to source',
  '左右键在章内滚动；上一章／下一章在加载成功后从章首展示。': 'Left and right arrows scroll within a chapter. Chapter navigation starts at the beginning.',
  '内容目录': 'Contents', '排版与外观': 'Typography and appearance',
  '默认沿用当前外观的排版；调整只作用于阅读内容。': 'Uses the current appearance by default. Changes affect reading content only.',
  '字号': 'Font size', '行距': 'Line height', '正文宽度': 'Content width',
  '界面主题': 'Appearance', '浅色': 'Light', '深色': 'Dark', '跟随系统': 'System',
  '收起侧栏': 'Collapse sidebar', '会话显示名称': 'Conversation name',
  '快捷键与唤出方式': 'Shortcuts and controls', '鼠标热区唤出': 'Open from screen corner',
  '热区位置': 'Corner position', '右上角': 'Top right', '左上角': 'Top left',
  '右下角': 'Bottom right', '左下角': 'Bottom left',
  '停留时间（毫秒）': 'Hover delay (ms)', '收起延迟（毫秒）': 'Close delay (ms)',
  '失焦自动遮挡': 'Hide when unfocused', '左右键导航': 'Arrow key navigation',
  '来源信息': 'Source', '当前文档': 'Current document',
  '部分内容可能无法完整转换，请在恢复原页面后核对。': 'Some content may not convert completely. Check the source page after returning.',
  '选择 TXT 文件': 'Choose TXT file', '重新选择编码': 'Choose encoding again',
  '重新连接': 'Reconnect', '刷新来源': 'Refresh source', '快速隐私': 'Quick privacy',
  '继续': 'Continue', '返回原阅读页': 'Return to source page', '恢复原页面': 'Restore source page',
  '返回阅读': 'Return to reading', ' · 当前': ' · Current',
  '当前已加载内容的末尾': 'End of loaded content', '已到末尾': 'End of content',
  '获取后续内容': 'Load more content', '正文': 'Response'
};
const chinese = new Map(Object.entries(controls).map(([zh, en]) => [en, zh]));
export function applyReaderControlsLanguage(root: HTMLElement, language: DisplayLanguage): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.textContent ?? '';
    const trimmed = value.trim();
    const zh = controls[trimmed] ? trimmed : chinese.get(trimmed);
    if (zh) node.textContent = value.replace(trimmed, language === 'en' ? controls[zh]! : zh);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[aria-label]')) {
    const value = element.getAttribute('aria-label') ?? '';
    const zh = controls[value] ? value : chinese.get(value);
    if (zh) element.setAttribute('aria-label', language === 'en' ? controls[zh]! : zh);
  }
}
