import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FIELD = fs.readFileSync(new URL('../public/field.html', import.meta.url), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `应存在函数 ${name}`);
  const parenOpen = src.indexOf('(', start);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    if (src[i] === ')' && --parenDepth === 0) { parenClose = i; break; }
  }
  assert.ok(parenClose > parenOpen, `${name} 参数括号应闭合`);
  const braceOpen = src.indexOf('{', parenClose);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 函数体未闭合`);
}

test('AC-46 统一 lightbox 结构、视口约束与无障碍契约', () => {
  assert.match(FIELD, /<dialog[^>]*id="fImageLightbox"[^>]*aria-label="图片预览"/, '当前页使用一个具名 dialog');
  assert.match(FIELD, /id="fImageLightboxImage"[^>]*alt=""/, '大图节点具备 alt，打开时按上下文更新');
  assert.match(FIELD, /id="fImageLightboxClose"[^>]*aria-label="关闭图片预览"/, '关闭按钮有可访问名称');
  const closeCss = (FIELD.match(/\.f-image-lightbox-close\s*\{[^}]*\}/) || [''])[0];
  assert.match(closeCss, /width:\s*44px/, '关闭按钮宽度至少 44px');
  assert.match(closeCss, /height:\s*44px/, '关闭按钮高度至少 44px');
  const imageCss = (FIELD.match(/\.f-image-lightbox-image\s*\{[^}]*\}/) || [''])[0];
  assert.match(imageCss, /max-width:\s*calc\(100vw\s*-\s*48px\)/, '大图宽度适配视口');
  assert.match(imageCss, /max-height:\s*calc\(100vh\s*-\s*48px\)/, '大图高度适配视口');
  assert.match(FIELD, /\.f-image-preview-trigger:focus-visible[^}]*outline:/, '缩略图键盘焦点可见');
  assert.match(FIELD, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.f-image-lightbox\s*\{\s*transition:\s*none/, '尊重 reduced-motion');
});

test('AC-46 三类图片入口统一走可键盘激活的 button，不再依赖新标签页', () => {
  const bubbles = extractFn(FIELD, 'bubbleImgs');
  const pending = extractFn(FIELD, 'renderImgPreview');
  const ticket = extractFn(FIELD, 'renderTicketDrawer');
  const trigger = extractFn(FIELD, 'createImagePreviewTrigger');
  assert.match(bubbles, /createImagePreviewTrigger\(/, '实时及历史恢复气泡共用统一触发器');
  assert.match(pending, /createImagePreviewTrigger\(/, '待发送图片共用统一触发器');
  assert.match(ticket, /<button class="f-image-preview-trigger"/, '工单历史图片使用同一按钮契约');
  assert.match(trigger, /btn\.type\s*=\s*'button'/, '原生 button 自带 Enter/Space 激活语义');
  assert.match(trigger, /aria-label/, '缩略图按钮有可访问名称');
  assert.doesNotMatch(bubbles + pending + ticket, /target\s*=\s*["']?_blank|\.target\s*=\s*['"]_blank/, '图片预览不再依赖 target=_blank');
});

test('AC-46 open/close 真逻辑锁滚动、适配 data/API URL，并在关闭后恢复焦点', () => {
  const elements = {};
  const document = {
    body: { style: { overflow: 'auto' } },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(), attributes: {}, children: [], className: '', type: '', src: '', alt: '', loading: '',
        setAttribute(k, v) { this.attributes[k] = v; },
        appendChild(v) { this.children.push(v); },
      };
    },
  };
  elements.fImageLightbox = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  elements.fImageLightboxImage = {
    src: '', alt: '',
    removeAttribute(k) { if (k === 'src') this.src = ''; },
  };
  elements.fImageLightboxClose = { focusCalls: 0, focus() { this.focusCalls++; } };
  const factory = new Function('$', 'document', [
    extractFn(FIELD, 'createImagePreviewTrigger'),
    "var imagePreviewTrigger = null, imagePreviewBodyOverflow = '';",
    extractFn(FIELD, 'openImagePreview'),
    extractFn(FIELD, 'closeImagePreview'),
    'return { createImagePreviewTrigger, openImagePreview, closeImagePreview };',
  ].join('\n'));
  const api = factory((id) => elements[id], document);
  const trigger = { isConnected: true, focusCalls: 0, focus() { this.focusCalls++; } };

  api.openImagePreview('data:image/png;base64,AAAA', '粘贴截图', trigger);
  assert.equal(elements.fImageLightbox.open, true, 'data URL 可在当前页打开');
  assert.equal(elements.fImageLightboxImage.src, 'data:image/png;base64,AAAA');
  assert.equal(elements.fImageLightboxImage.alt, '粘贴截图', '大图有上下文可访问名称');
  assert.equal(document.body.style.overflow, 'hidden', '打开时锁 body 滚动');
  assert.equal(elements.fImageLightboxClose.focusCalls, 1, '打开后焦点进入关闭按钮');

  api.openImagePreview('/api/intake-media?project=pwrs&file=media%2Fx.png', '历史截图', trigger);
  assert.match(elements.fImageLightboxImage.src, /^\/api\/intake-media/, '历史 API URL 同样可预览');
  api.closeImagePreview();
  assert.equal(elements.fImageLightbox.open, false);
  assert.equal(document.body.style.overflow, 'auto', '关闭后恢复原 body 滚动状态');
  assert.equal(trigger.focusCalls, 1, '关闭后焦点回到触发缩略图');
  assert.equal(elements.fImageLightboxImage.src, '', '关闭后清理大图 URL');
});

test('AC-46 关闭按钮、遮罩、Esc 都收口到 closeImagePreview，删除×不误触', () => {
  const bind = extractFn(FIELD, 'bindImagePreview');
  const pending = extractFn(FIELD, 'renderImgPreview');
  assert.match(bind, /close\.addEventListener\('click', closeImagePreview\)/, '关闭按钮关闭');
  assert.match(bind, /if \(ev\.target === dlg\) closeImagePreview\(\)/, '点击 dialog 遮罩关闭');
  assert.match(bind, /addEventListener\('cancel'[\s\S]*?preventDefault\(\)[\s\S]*?closeImagePreview\(\)/, '原生 Esc/cancel 关闭');
  assert.match(FIELD, /imageLightbox && imageLightbox\.open[\s\S]{0,120}closeImagePreview\(\); return/, '全局 Esc 优先关闭最上层图片预览');
  assert.match(pending, /rm\.addEventListener\('click'[\s\S]*?ev\.stopPropagation\(\)[\s\S]*?pendingImages\.splice/, '删除×阻止冒泡后再删除，不误触预览');
});
