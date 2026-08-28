// CU-01 · 激活文件生成（设备码 → .lc-activation.lic）· 脱库逻辑测试（零依赖，node --test）
//   背景：运营端「医院管理」新增「激活文件生成」——传入设备码 → 算 license → 生成 .lc-activation.lic 激活文件下载。
//   算法（复刻产品 IRegistrationServiceImpl.generateLicense/calculateHash · 逐字校对 + 校验器 SystemActivationValidator 确认）：
//     license = Base64_标准( SHA-256( UTF8(设备码 + "lingchuang@123") ) )。标准 Base64（含 +///=、带 padding）= Node digest('base64')。
//   本测试：从 server.mjs 抽真身 activationLicense/activationFileContent 沙箱 eval（测真实源码，能抓漂移），断言黄金向量证复刻 Java 一致；
//     + 文件内容/格式断言；+ 端点静态断言（存在、POST、走 admin 闸=不在 FIELD_OK/FS08_FIELD_API/LINK_OK）；+ 前端落点断言。
//   纯计算：不落库、不写盘、无字段映射——故无「连真库」用例（激活生成不碰 MySQL，见交付说明）。
//   用法：node --test tools/activation-license.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/customers.html'), 'utf8');

// 黄金向量（必须证复刻 Java 一致；勿改）
const GOLDEN_DEVICE = '4aea73e50cc4f679124cb68ac02942e';
const GOLDEN_LICENSE = 'Kz3W2wXfWO9/NvRWxl7UCxLyyYcKh2WxMT+aeBSnxi8=';

// —— 从源码抽出具名函数体，沙箱 eval（测真实源码，非重写副本，能抓漂移） —— //
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}
// 抽 VERIFY_KEY 常量 + 两个函数（activationFileContent 依赖 activationLicense；均依赖 crypto + ACTIVATION_VERIFY_KEY）
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*[^;\\n]+;'));
  assert.ok(m, `应能在 server.mjs 找到 const ${name}`);
  return m[0];
}
const sandbox = new Function('crypto',
  extractConst(SRC, 'ACTIVATION_VERIFY_KEY') + '\n' +
  extractFn(SRC, 'activationLicense') + '\n' +
  extractFn(SRC, 'activationFileContent') + '\n' +
  'return { activationLicense, activationFileContent, ACTIVATION_VERIFY_KEY };'
)(crypto);

// ---- 黄金向量：证复刻 Java（IRegistrationServiceImpl）一致 ----
test('[黄金向量] activationLicense(设备码) 恒等 Java 产出（Base64(SHA-256(设备码+lingchuang@123)))', () => {
  assert.equal(sandbox.ACTIVATION_VERIFY_KEY, 'lingchuang@123', 'VERIFY_KEY 固定 = lingchuang@123（产品 CommonConstant.VERIFY_KEY）');
  assert.equal(sandbox.activationLicense(GOLDEN_DEVICE), GOLDEN_LICENSE, '黄金向量必须一字不差（证与 Java 校验器同源）');
  // 标准 Base64（含 padding）：本向量末尾有 = 填充
  assert.ok(GOLDEN_LICENSE.endsWith('='), '标准 Base64 带 padding（=）');
  // 独立复算（不经真身）交叉校验，双保险
  const indep = crypto.createHash('sha256').update(GOLDEN_DEVICE + 'lingchuang@123', 'utf8').digest('base64');
  assert.equal(indep, GOLDEN_LICENSE, '独立复算与黄金向量一致');
});

// ---- 文件内容/格式：Java Properties（首行注释 + activation_key=license）----
test('[文件格式] activationFileContent 含 #System Activation License + activation_key=<license>', () => {
  const content = sandbox.activationFileContent(GOLDEN_DEVICE);
  assert.match(content, /^#System Activation License\n/, '首行注释 #System Activation License');
  assert.match(content, /\nactivation_key=/, 'property key 固定 activation_key（VerifyConstant.ACTIVATION_KEY）');
  assert.ok(content.includes('activation_key=' + GOLDEN_LICENSE), 'activation_key= 后接黄金 license');
  // base64 值里的 =/+/ 直接写、不转义（Properties.load 取第一个 = 后全部为 value 字面量）
  assert.ok(content.includes(GOLDEN_LICENSE), 'license 里的 +/// 原样，不转义');
  assert.ok(content.endsWith('\n'), '末尾换行');
  // 读回验证：模拟 Properties.getProperty('activation_key') = 第一个 = 后全部
  const line = content.split('\n').find(l => l.startsWith('activation_key='));
  assert.equal(line.slice('activation_key='.length), GOLDEN_LICENSE, 'Properties 读回 activation_key 值 = 原 license（含 = padding 不丢）');
});

// ---- 不同设备码 → 不同 license（非常量、真依赖入参）----
test('[敏感性] 不同设备码产出不同 license；改 key 会破坏黄金向量（证 key 参与）', () => {
  assert.notEqual(sandbox.activationLicense('other-device-code'), GOLDEN_LICENSE, '不同设备码 → 不同 license');
  const wrongKey = crypto.createHash('sha256').update(GOLDEN_DEVICE + 'wrong@key', 'utf8').digest('base64');
  assert.notEqual(wrongKey, GOLDEN_LICENSE, '换 key 得不到黄金向量（证 lingchuang@123 参与哈希）');
});

// ---- 端点静态断言：/api/activation/generate 存在、POST、走 admin 闸（不在任何 field/link 白名单）----
test('[端点·存在+POST] /api/activation/generate 端点存在且限 POST', () => {
  assert.match(SRC, /url\.pathname === '\/api\/activation\/generate' && req\.method === 'POST'/, '端点存在且限 POST');
  // 空设备码 → 400「设备码不能为空」；长度上限 200
  assert.match(SRC, /设备码不能为空/, '空设备码返回「设备码不能为空」');
  assert.match(SRC, /deviceCode\.length > 200/, '设备码长度上限 200 防滥用');
  // 出参含 filename/.lc-activation.lic + content
  assert.match(SRC, /filename: '\.lc-activation\.lic'/, "返回 filename='.lc-activation.lic'");
  assert.match(SRC, /content: activationFileContent\(deviceCode\)/, '返回 content=activationFileContent(deviceCode)');
});

test('[端点·admin 闸] /api/activation/generate 绝不进 FIELD_OK / FS08_FIELD_API / LINK_OK（运营端功能，authGate deny-by-default）', () => {
  // 抽三份白名单常量文本，断言激活端点均不在其中——非管理员由 authGate 自动 403、field 域由 originGate deny→403。
  const linkOk = SRC.match(/const LINK_OK = new Set\(\[[^\]]*\]\)/)[0];
  const fieldOk = SRC.match(/const FIELD_OK = new Set\(\[[^\]]*\]\)/)[0];
  const fs08 = SRC.match(/const FS08_FIELD_API = new Set\(\[[^\]]*\]\)/)[0];
  assert.ok(!linkOk.includes('/api/activation/generate'), '不在 LINK_OK（访客链接不可用）');
  assert.ok(!fieldOk.includes('/api/activation/generate'), '不在 FIELD_OK（现场账号不可用）');
  assert.ok(!fs08.includes('/api/activation/generate'), '不在 FS08_FIELD_API（field 域外层闸拒）');
  // 反向：admin 域 originGate 对 /api/* 恒放行（return 'allow'），故管理员可用——断言 admin 分支保持全放行
  assert.match(SRC, /origin === 'admin'[\s\S]*?return 'allow';/, "admin 域 originGate 对接口恒 return 'allow'（管理员可达）");
});

// ---- 前端落点：customers.html 行内「激活文件」+ 工具条按钮 + openActivation 从 deviceCode 预填 + Blob 下载 .lc-activation.lic ----
test('[前端] customers.html 有 data-act="activation" 行操作 + 工具条按钮 + openActivation + Blob 下载 .lc-activation.lic', () => {
  // 行内操作 + 工具条按钮
  assert.match(HTML, /data-act="activation"/, '行内「激活文件」操作 data-act="activation"');
  assert.match(HTML, /id="btnActivation"/, '工具条「激活文件生成」按钮 #btnActivation');
  // openActivation(prefill) + 两处调用（工具条空、行内从 deviceCode 预填）
  assert.match(HTML, /function openActivation\(prefill\)/, '存在 openActivation(prefill)');
  assert.match(HTML, /openActivation\(c\.deviceCode\|\|''\)/, '行内从该医院 deviceCode 预填');
  assert.match(HTML, /openActivation\(''\)/, '工具条不选医院、空设备码手输');
  // 调 /api/activation/generate
  assert.match(HTML, /\/api\/activation\/generate/, '打 /api/activation/generate');
  // Blob 下载：a.download=.lc-activation.lic
  assert.match(HTML, /new Blob\(/, 'Blob 下载');
  assert.match(HTML, /a\.download\s*=\s*r\.filename\|\|'\.lc-activation\.lic'/, "a.download 用后端 filename，兜底 '.lc-activation.lic'");
  // 空设备码不发请求（前端拦）
  assert.match(HTML, /if\(!deviceCode\)\{[^}]*return;/, '设备码空时提示、不发请求');
});
