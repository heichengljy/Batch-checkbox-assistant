let lastExtractedInfo = null;
let promptText = '';
const STORAGE_KEY = 'aiHelperData';
const SETTINGS_KEY = 'helperSettings';
let isLogOpen = false;
let isSupportOk = false;
let currentMode = 'checkbox';
let globalSettings = {};
let isCapturing = false;
let abortCapture = false;
let popupPort = null;
let systemThemeListener = null;

const NEW_PREFIX = `请根据我提供的页面文字/图片/文件，仅识别出支持的三种题型（选择/判断/多选题）的题目和选项，并给出正确答案。返回答案格式为JSON，键为题目序号（从第1个支持的题目开始），值为对应字母（如"A"）。多选用数组表示，例如 {"3": ["A","C"]}。判断题请返回 "A"（对）或 "B"（错）。
页面内容如下：`;
const NEW_SUFFIX = `只返回仅作答选择/判断/多选题的答案JSON，不要其他文字。示例：{"1":"B","2":["A","C"],"3":"A"}`;

const DEFAULT_SETTINGS = {
  clickDelay: 25,
  promptPrefix: NEW_PREFIX,
  promptSuffix: NEW_SUFFIX,
  screenshotDelay: 160,
  cropStartRatio: 0.2,
  cropEndRatio: 0.8,
  cropLeftRatio: 0,
  cropRightRatio: 1,
  theme: 'system'
};

function formatQuestionCount(count) {
  return String(count);
}

// ===================== 主题管理 =====================
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme, animate = true) {
  const body = document.body;
  if (animate) {
    body.classList.add('theme-transition');
    clearTimeout(body._themeTimer);
    body._themeTimer = setTimeout(() => {
      body.classList.remove('theme-transition');
    }, 500);
  }
  let effectiveTheme = theme;
  if (theme === 'system') {
    effectiveTheme = getSystemTheme();
  }
  if (effectiveTheme === 'dark') {
    body.classList.add('dark-mode');
  } else {
    body.classList.remove('dark-mode');
  }
}

function setupSystemThemeListener() {
  if (systemThemeListener) {
    systemThemeListener.removeListener();
    systemThemeListener = null;
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e) => {
    if (globalSettings.theme === 'system') {
      applyTheme('system', true);
    }
  };
  media.addEventListener('change', handler);
  systemThemeListener = {
    removeListener: () => media.removeEventListener('change', handler)
  };
}

async function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get([SETTINGS_KEY], result => {
      const saved = result[SETTINGS_KEY] || {};
      globalSettings = {
        ...DEFAULT_SETTINGS,
        ...saved
      };
      const delayNum = Number(globalSettings.clickDelay);
      globalSettings.clickDelay = isNaN(delayNum) ? DEFAULT_SETTINGS.clickDelay : delayNum;
      const sDelay = Number(globalSettings.screenshotDelay);
      globalSettings.screenshotDelay = isNaN(sDelay) ? DEFAULT_SETTINGS.screenshotDelay : sDelay;
      globalSettings.cropStartRatio = Math.min(1, Math.max(0, globalSettings.cropStartRatio));
      globalSettings.cropEndRatio = Math.min(1, Math.max(0, globalSettings.cropEndRatio));
      if (globalSettings.cropStartRatio >= globalSettings.cropEndRatio) {
        globalSettings.cropStartRatio = Math.max(0, globalSettings.cropEndRatio - 0.01);
      }
      globalSettings.cropLeftRatio = Math.min(1, Math.max(0, globalSettings.cropLeftRatio));
      globalSettings.cropRightRatio = Math.min(1, Math.max(0, globalSettings.cropRightRatio));
      if (globalSettings.cropLeftRatio >= globalSettings.cropRightRatio) {
        globalSettings.cropLeftRatio = Math.max(0, globalSettings.cropRightRatio - 0.01);
      }
      resolve(globalSettings);
    });
  });
}

async function saveSettings(newSettings) {
  Object.assign(globalSettings, newSettings);
  globalSettings.clickDelay = Number(globalSettings.clickDelay);
  globalSettings.screenshotDelay = Number(globalSettings.screenshotDelay);
  globalSettings.cropStartRatio = Math.min(1, Math.max(0, globalSettings.cropStartRatio));
  globalSettings.cropEndRatio = Math.min(1, Math.max(0, globalSettings.cropEndRatio));
  if (globalSettings.cropStartRatio >= globalSettings.cropEndRatio) {
    if (newSettings.cropStartRatio !== undefined) {
      globalSettings.cropEndRatio = Math.min(1, globalSettings.cropStartRatio + 0.01);
    } else {
      globalSettings.cropStartRatio = Math.max(0, globalSettings.cropEndRatio - 0.01);
    }
  }
  globalSettings.cropLeftRatio = Math.min(1, Math.max(0, globalSettings.cropLeftRatio));
  globalSettings.cropRightRatio = Math.min(1, Math.max(0, globalSettings.cropRightRatio));
  if (globalSettings.cropLeftRatio >= globalSettings.cropRightRatio) {
    if (newSettings.cropLeftRatio !== undefined) {
      globalSettings.cropRightRatio = Math.min(1, globalSettings.cropLeftRatio + 0.01);
    } else {
      globalSettings.cropLeftRatio = Math.max(0, globalSettings.cropRightRatio - 0.01);
    }
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: globalSettings });
  if (lastExtractedInfo) {
    promptText = buildPrompt(lastExtractedInfo);
  }
}

function updatePromptInputs() {
  const preEl = document.getElementById('promptPrefix');
  const sufEl = document.getElementById('promptSuffix');
  if (preEl) preEl.value = globalSettings.promptPrefix;
  if (sufEl) sufEl.value = globalSettings.promptSuffix;
}

// ===================== 比例显示 =====================
function updateRatioDisplay() {
  const startPct = Math.round(globalSettings.cropStartRatio * 100);
  const endPct = Math.round(globalSettings.cropEndRatio * 100);
  const stepPct = endPct - startPct;
  const leftPct = Math.round(globalSettings.cropLeftRatio * 100);
  const rightPct = Math.round(globalSettings.cropRightRatio * 100);
  const widthPct = rightPct - leftPct;
  const startDom = document.getElementById('startRatioDisplay');
  const endDom = document.getElementById('endRatioDisplay');
  const stepDom = document.getElementById('stepDisplay');
  const leftDom = document.getElementById('leftRatioDisplay');
  const rightDom = document.getElementById('rightRatioDisplay');
  const widthDom = document.getElementById('widthDisplay');
  if (startDom) startDom.textContent = startPct + '%';
  if (endDom) endDom.textContent = endPct + '%';
  if (stepDom) stepDom.textContent = stepPct + '%';
  if (leftDom) leftDom.textContent = leftPct + '%';
  if (rightDom) rightDom.textContent = rightPct + '%';
  if (widthDom) widthDom.textContent = widthPct + '%';
  const startTip = document.getElementById('startRatioTip');
  const endTip = document.getElementById('endRatioTip');
  if (startTip) startTip.textContent = startPct + '%';
  if (endTip) endTip.textContent = endPct + '%';
  refreshBtnState();
}

function refreshBtnState() {
  const startPct = Math.round(globalSettings.cropStartRatio * 100);
  const endPct = Math.round(globalSettings.cropEndRatio * 100);
  const leftPct = Math.round(globalSettings.cropLeftRatio * 100);
  const rightPct = Math.round(globalSettings.cropRightRatio * 100);
  const startUp = document.querySelector('[data-target="startRatio"].up');
  const startDown = document.querySelector('[data-target="startRatio"].down');
  const endUp = document.querySelector('[data-target="endRatio"].up');
  const endDown = document.querySelector('[data-target="endRatio"].down');
  if (startUp) startUp.disabled = startPct <= 0;
  if (startDown) startDown.disabled = startPct + 1 >= endPct;
  if (endUp) endUp.disabled = endPct - 1 <= startPct;
  if (endDown) endDown.disabled = endPct >= 100;
  const leftUp = document.querySelector('[data-target="leftRatio"].up');
  const leftDown = document.querySelector('[data-target="leftRatio"].down');
  const rightUp = document.querySelector('[data-target="rightRatio"].up');
  const rightDown = document.querySelector('[data-target="rightRatio"].down');
  if (leftUp) leftUp.disabled = leftPct <= 0;
  if (leftDown) leftDown.disabled = leftPct + 1 >= rightPct;
  if (rightUp) rightUp.disabled = rightPct - 1 <= leftPct;
  if (rightDown) rightDown.disabled = rightPct >= 100;
}

// ===================== 核心功能 =====================
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function saveData(data) {
  return new Promise(resolve => chrome.storage.local.set({ [STORAGE_KEY]: data }, resolve));
}

async function loadData() {
  return new Promise(resolve => chrome.storage.local.get([STORAGE_KEY], result => resolve(result[STORAGE_KEY] || null)));
}

async function ensureContentScript() {
  const tab = await getActiveTab();
  const url = tab.url || '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.warn('跳过注入：非 HTTP/HTTPS 页面', url);
    return false;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => typeof window.extractPageInfo === 'function'
    });
    if (results && results[0] && results[0].result) return true;
  } catch (e) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    return true;
  } catch (e) {
    console.error('注入 content script 失败:', e);
    return false;
  }
}

async function extractPageInfo() {
  const tab = await getActiveTab();
  const url = tab.url || '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('请在普通网页上使用本扩展');
  }
  const injected = await ensureContentScript();
  if (!injected) throw new Error('注入 content script 失败，请刷新页面重试');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.extractPageInfo()
  });
  if (results && results[0] && results[0].result) {
    return results[0].result;
  } else {
    throw new Error('无法获取页面信息');
  }
}

function buildPrompt(info) {
  let prompt = globalSettings.promptPrefix;
  if (info.allQuestions) {
    info.allQuestions.forEach(q => {
      prompt += `第${q.number}题：${q.title}\n`;
      q.options.forEach(opt => {
        let displayLetter = opt.letter;
        if (displayLetter === 'true') displayLetter = 'A';
        else if (displayLetter === 'false') displayLetter = 'B';
        prompt += `  ${displayLetter}. ${opt.label}\n`;
      });
      prompt += '\n';
    });
  } else if (info.allGroups && info.mode === 'checkbox') {
    prompt += info.rawText + '\n';
  } else if (info.allGroups) {
    info.allGroups.forEach(g => {
      prompt += `第${g.groupIndex}题：${g.title || ''}\n`;
      g.options.forEach(opt => prompt += `  ${opt.letter}. ${opt.label}\n`);
      prompt += '\n';
    });
  } else {
    prompt += info.rawText + '\n';
  }
  prompt += globalSettings.promptSuffix;
  return prompt;
}

function normalizeAnswer(answer) {
  if (typeof answer === 'boolean') return answer ? 'A' : 'B';
  if (typeof answer === 'string') {
    const lower = answer.toLowerCase();
    if (lower === 'true') return 'A';
    if (lower === 'false') return 'B';
    return answer.toUpperCase();
  }
  if (Array.isArray(answer)) return answer.map(a => normalizeAnswer(a));
  return answer;
}

async function getCurrentSelectedLetters(tabId, question) {
  try {
    const safeQuestion = JSON.parse(JSON.stringify(question));
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (q) => window.getCurrentSelected(q),
      args: [safeQuestion]
    });
    return result?.[0]?.result || [];
  } catch (e) {
    console.error('获取选中状态失败:', e);
    return [];
  }
}

async function clickOption(tabId, selector, isXuexitong) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, isXxt) => {
        if (isXxt) {
          const span = document.querySelector(sel);
          const target = span || document.querySelector(`span[data="${sel.match(/data="([^"]+)"/)?.[1] || ''}"]`);
          if (target) {
            const parent = target.closest('div.clearfix.answerBg');
            if (parent) {
              parent.scrollIntoView({ block: 'center', behavior: 'smooth' });
              parent.click();
              parent.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              parent.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              return true;
            }
          }
          return false;
        } else {
          let input = null;
          if (sel.startsWith('#')) {
            input = document.getElementById(sel.substring(1));
          } else if (sel.startsWith('input[')) {
            input = document.querySelector(sel);
          } else if (sel.startsWith('__index_')) {
            const index = parseInt(sel.split('_')[2]);
            const allInputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
            if (allInputs[index]) input = allInputs[index];
          }
          if (input) {
            input.scrollIntoView({ block: 'center', behavior: 'smooth' });
            input.click();
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        }
      },
      args: [selector, isXuexitong]
    });
    await new Promise(r => setTimeout(r, globalSettings.clickDelay));
    return true;
  } catch (e) {
    console.error(`点击失败: ${selector}`, e);
    return false;
  }
}

async function processQuestion(tabId, question, targetLetters, isXuexitong) {
  if (isXuexitong) {
    const isJudgment = question.options.some(opt => opt.letter === 'true' || opt.letter === 'false');
    let mappedTarget = targetLetters;
    if (isJudgment) {
      mappedTarget = targetLetters.map(l => {
        if (l === 'A') return 'true';
        if (l === 'B') return 'false';
        return l;
      });
    }
    const currentSelected = await getCurrentSelectedLetters(tabId, question);
    const currentSet = new Set(currentSelected);
    const targetSet = new Set(mappedTarget);
    let log = `题${question.number} 当前[${currentSelected.join(',')}] → 目标[${mappedTarget.join(',')}]`;
    if (currentSet.size === targetSet.size && [...currentSet].every(l => targetSet.has(l))) {
      return { count: mappedTarget.length, log: log + ' ✅ 已匹配' };
    }
    const toCancel = currentSelected.filter(l => !targetSet.has(l));
    const toSelect = mappedTarget.filter(l => !currentSet.has(l));
    let successCount = 0;
    for (const letter of toCancel) {
      const opt = question.options.find(o => o.letter === letter);
      if (opt) {
        const ok = await clickOption(tabId, opt.selector, true);
        if (ok) successCount++;
      }
    }
    for (const letter of toSelect) {
      const opt = question.options.find(o => o.letter === letter);
      if (opt) {
        const ok = await clickOption(tabId, opt.selector, true);
        if (ok) successCount++;
      }
    }
    return { count: successCount, log: log };
  } else {
    const currentSelected = await getCurrentSelectedLetters(tabId, question);
    const currentSet = new Set(currentSelected);
    const targetSet = new Set(targetLetters);
    const toCancel = currentSelected.filter(l => !targetSet.has(l));
    const toSelect = targetLetters.filter(l => !currentSet.has(l));
    let log = `题${question.groupIndex} 当前[${currentSelected.join(',')}]`;
    if (toCancel.length === 0 && toSelect.length === 0) {
      appendLog(`⏭️ ${log} → 无需操作`);
      return targetLetters.length;
    }
    appendLog(`🔧 ${log} → 取消[${toCancel.join(',')}] 选中[${toSelect.join(',')}]`);
    let successCount = 0;
    for (const letter of toCancel) {
      const opt = question.options.find(o => o.letter === letter);
      if (opt) {
        const ok = await clickOption(tabId, opt.selector, false);
        if (ok) successCount++;
      }
    }
    for (const letter of toSelect) {
      const opt = question.options.find(o => o.letter === letter);
      if (opt) {
        const ok = await clickOption(tabId, opt.selector, false);
        if (ok) successCount++;
      }
    }
    return successCount;
  }
}

// ===================== UI 工具 =====================
function setStatus(text, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  const allowTexts = ['提取成功，共', '未找到任何题目，请确认页面已加载完成。'];
  const isAllow = allowTexts.some(s => text.includes(s));
  if (isAllow) {
    // 先设置内容和颜色
    el.textContent = text;
    el.style.color = isError ? 'var(--status-fail)' : 'var(--text-muted)';
    // 然后渐变为可见（添加过渡）
    el.style.opacity = '1';
  } else {
    // 清空内容并隐藏（仍占位）
    el.textContent = '';
    el.style.opacity = '0';
  }
}

function appendLog(text) {
  const container = document.getElementById('logContainer');
  if (!container) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = text;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// ===================== 关键修改：先设置内容和样式，最后显示 =====================
function setSupportStatus(success, type = '') {
  const el = document.getElementById('supportStatus');
  if (!el) return;
  // 先设置内容和类（元素仍隐藏）
  if (success) {
    currentMode = type;
    el.textContent = type === 'xuexitong' ? '✅ 学习通页' : '✅ 复选框页';
    el.className = 'step-status success';
  } else {
    el.textContent = '❌ 非支持页';
    el.className = 'step-status fail';
  }
  // 最后才显示，避免默认颜色闪现
  el.style.display = 'inline';
  isSupportOk = success;
  setAllDisabled(!success);
  if (lastExtractedInfo) {
    promptText = buildPrompt(lastExtractedInfo);
  }
}

function setAllDisabled(disabled) {
  const copyBtn = document.getElementById('copyPromptBtn');
  const execBtn = document.getElementById('executeBtn');
  const textarea = document.getElementById('aiResponse');
  const templateBtn = document.getElementById('copyTemplateBtn');
  if (disabled) {
    if (copyBtn) copyBtn.classList.add('disabled');
    if (execBtn) execBtn.classList.add('disabled');
    if (templateBtn) templateBtn.classList.add('disabled');
    if (textarea) textarea.disabled = true;
  } else {
    if (copyBtn) copyBtn.classList.remove('disabled');
    if (execBtn) execBtn.classList.remove('disabled');
    if (templateBtn) templateBtn.classList.remove('disabled');
    if (textarea) textarea.disabled = false;
  }
}

function resetButton(btnId, defaultText) {
  const el = document.getElementById(btnId);
  if (!el) return;
  el.textContent = defaultText;
  el.className = 'step-btn';
  if (!isSupportOk) el.classList.add('disabled');
}

function setButtonState(btnId, text, stateClass) {
  const el = document.getElementById(btnId);
  if (!el) return;
  el.textContent = text;
  el.className = 'step-btn ' + stateClass;
  if (!isSupportOk) el.classList.add('disabled');
}

// ===================== 设置面板 =====================
function toggleSettings() {
  if (isCapturing) {
    appendLog('⏳ 截图进行中，请等待完成后再操作设置');
    return;
  }
  const main = document.getElementById('mainContent');
  const panelDom = document.getElementById('settingsPanel');
  const btn = document.getElementById('settingsBtn');
  if (panelDom.classList.contains('hidden')) {
    main.classList.add('fade-out');
    setTimeout(() => {
      main.classList.add('hidden');
      panelDom.classList.remove('hidden');
      setTimeout(() => panelDom.classList.remove('fade-out'), 10);
      btn.textContent = '⬅️ 返回';
      document.querySelector('.tab-btn[data-tab="core"]')?.click();
    }, 300);
  } else {
    panelDom.classList.add('fade-out');
    setTimeout(async () => {
      panelDom.classList.add('hidden');
      main.classList.remove('hidden');
      setTimeout(() => main.classList.remove('fade-out'), 10);
      btn.textContent = '⚙️ 设置';
      await clearGuideLines(true);
    }, 300);
  }
}

async function resetToDefault() {
  if (!confirm('确定要恢复所有默认设置吗？')) return;
  globalSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  await saveSettings({});
  document.querySelectorAll('input[name="delay"]').forEach(radio => {
    radio.checked = parseInt(radio.value) === DEFAULT_SETTINGS.clickDelay;
  });
  document.querySelectorAll('input[name="screenshotDelay"]').forEach(radio => {
    radio.checked = parseInt(radio.value) === DEFAULT_SETTINGS.screenshotDelay;
  });
  document.querySelectorAll('input[name="theme"]').forEach(radio => {
    radio.checked = radio.value === DEFAULT_SETTINGS.theme;
  });
  applyTheme(DEFAULT_SETTINGS.theme, true);
  updateRatioDisplay();
  updateScreenshotDelayTip();
  updatePromptInputs();
  appendLog('✅ 已恢复默认设置，提示词重置完成');
}

function updateScreenshotDelayTip() {
  const tip = document.getElementById('screenshotDelayTip');
  const checked = document.querySelector('input[name="screenshotDelay"]:checked');
  if (!checked || !tip) return;
  const val = parseInt(checked.value);
  let text = '', cls = '';
  if (val < 160) {
    text = '⚠️ 可能过快';
    cls = 'danger';
  } else if (val === 160) {
    text = '✅ 推荐速度';
    cls = 'success';
  } else {
    text = '⏳ 页面加载';
    cls = 'warn';
  }
  tip.textContent = text;
  tip.className = 'delay-tip ' + cls;
}
const updateScreenshotTip = updateScreenshotDelayTip;

// ===================== 辅助线绘制 =====================
async function drawGuideLines() {
  try {
    const tab = await getActiveTab();
    if (!tab.id) return;
    const url = tab.url || '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    const injected = await ensureContentScript();
    if (!injected) return;
    const { cropStartRatio, cropEndRatio, cropLeftRatio, cropRightRatio } = globalSettings;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sR, eR, lR, rR) => {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const containerId = 'helper-lines-container';
        let container = document.getElementById(containerId);
        function getOrCreateElement(id, tag, parent) {
          let el = document.getElementById(id);
          if (!el) {
            el = document.createElement(tag);
            el.id = id;
            parent.appendChild(el);
          }
          return el;
        }
        if (!container) {
          container = document.createElement('div');
          container.id = containerId;
          container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            pointer-events: none;
            z-index: 999999;
          `;
          document.body.appendChild(container);
          ['line-start', 'line-end', 'line-left', 'line-right'].forEach(id => {
            const el = document.createElement('div');
            el.id = id;
            container.appendChild(el);
          });
          ['label-start', 'label-end', 'label-left', 'label-right'].forEach(id => {
            const el = document.createElement('div');
            el.id = id;
            container.appendChild(el);
          });
        }
        function updateLine(id, left, top, width, height, color, isHorizontal) {
          const el = document.getElementById(id);
          if (!el) return;
          if (isHorizontal) {
            el.style.cssText = `
              position: absolute;
              left: ${left}px;
              top: ${top}px;
              width: ${width}px;
              height: 0;
              border-top: 2px dashed ${color};
              pointer-events: none;
            `;
          } else {
            el.style.cssText = `
              position: absolute;
              left: ${left}px;
              top: ${top}px;
              width: 0;
              height: ${height}px;
              border-left: 2px dashed ${color};
              pointer-events: none;
            `;
          }
        }
        function updateLabel(id, text, left, top, color) {
          const el = document.getElementById(id);
          if (!el) return;
          el.textContent = text;
          el.style.cssText = `
            position: absolute;
            left: ${left}px;
            top: ${top}px;
            color: ${color};
            font-size: 12px;
            font-weight: bold;
            background: rgba(255,255,255,0.8);
            padding: 0 4px;
            border-radius: 2px;
            pointer-events: none;
            font-family: sans-serif;
          `;
        }
        const startY = Math.round(vh * sR);
        const endY = Math.round(vh * eR);
        const leftX = Math.round(vw * lR);
        const rightX = Math.round(vw * rR);
        updateLine('line-start', 0, startY, vw, 0, '#ff0000', true);
        updateLine('line-end', 0, endY, vw, 0, '#0066ff', true);
        updateLine('line-left', leftX, 0, 0, vh, '#cc9900', false);
        updateLine('line-right', rightX, 0, 0, vh, '#008800', false);
        updateLabel('label-start', '起始线', 4, startY - 18, '#ff0000');
        updateLabel('label-end', '步长线', 4, endY - 18, '#0066ff');
        updateLabel('label-left', '左边界', leftX + 4, 4, '#cc9900');
        updateLabel('label-right', '右边界', rightX + 4, 4, '#008800');
      },
      args: [cropStartRatio, cropEndRatio, cropLeftRatio, cropRightRatio]
    });
    updateRatioDisplay();
  } catch (e) {
    console.debug('绘制辅助线失败:', e);
  }
}

async function clearGuideLines(immediate = false) {
  try {
    const tab = await getActiveTab();
    if (!tab.id) return;
    const url = tab.url || '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    const injected = await ensureContentScript();
    if (!injected) return;
    await chrome.tabs.sendMessage(tab.id, { action: 'clearLines', immediate }).catch(() => {});
  } catch (e) {
    console.debug('清除辅助线失败:', e);
  }
}

// ===================== 业务流程 =====================
async function autoExtract() {
  try {
    const info = await extractPageInfo();
    lastExtractedInfo = info;
    if (info.allQuestions && info.allQuestions.length > 0) {
      await saveData(info);
      promptText = buildPrompt(info);
      const countEl = document.getElementById('questionCount');
      if (countEl) countEl.textContent = formatQuestionCount(info.allQuestions.length);
      const statusTxt = `提取成功，共 ${info.allQuestions.length} 道题`;
      setStatus(statusTxt);
      appendLog(`✅ 学习通模式：提取到 ${info.allQuestions.length} 道题`);
      setSupportStatus(true, 'xuexitong');
      return true;
    } else if (info.allGroups && info.allGroups.length > 0) {
      promptText = buildPrompt(info);
      const countEl = document.getElementById('questionCount');
      if (countEl) countEl.textContent = formatQuestionCount(info.allGroups.length);
      const statusTxt = `提取成功，共 ${info.allGroups.length} 道题`;
      setStatus(statusTxt);
      appendLog(`✅ 复选框模式：提取到 ${info.allGroups.length} 组题目`);
      if (info.allGroups[0]?.options[0]?.selector) {
        appendLog(`🔍 第一题首个选项选择器: ${info.allGroups[0].selector}`);
      }
      setSupportStatus(true, 'checkbox');
      return true;
    } else {
      const countEl = document.getElementById('questionCount');
      if (countEl) countEl.textContent = formatQuestionCount(0);
      setSupportStatus(false);
      setStatus('未找到任何题目，请确认页面已加载完成。', true);
      appendLog('❌ ' + (info.error || '未检测到有效题目'));
      return false;
    }
  } catch (e) {
    const countEl = document.getElementById('questionCount');
    if (countEl) countEl.textContent = formatQuestionCount(0);
    setSupportStatus(false);
    setStatus('未找到任何题目，请确认页面已加载完成。', true);
    appendLog('❌ 提取失败：' + e.message);
    return false;
  }
}

async function copyPrompt() {
  if (!isSupportOk) return;
  if (!promptText) {
    const ok = await autoExtract();
    if (!ok) {
      appendLog('❌ 无法提取题目信息，请刷新页面重试');
      return;
    }
  }
  try {
    await navigator.clipboard.writeText(promptText);
    setButtonState('copyPromptBtn', '复制完成', 'done');
    appendLog('✅ 提示词已复制（全局统一模板）');
    setTimeout(() => resetButton('copyPromptBtn', '复制喂AI'), 2500);
  } catch (e) {
    appendLog('❌ 复制失败：' + e.message);
  }
}

async function copyTemplateOnly() {
  if (!isSupportOk) return;
  const template = (globalSettings.promptPrefix || '') + (globalSettings.promptSuffix || '');
  if (!template.trim()) {
    appendLog('⚠️ 提示词模板为空，请先在设置中配置');
    return;
  }
  try {
    await navigator.clipboard.writeText(template);
    const btn = document.getElementById('copyTemplateBtn');
    btn.textContent = '复制成功';
    btn.className = 'step-btn done';
    appendLog('✅ 提示词模板已复制');
    setTimeout(() => {
      btn.textContent = '仅提示词';
      btn.className = 'step-btn';
      if (!isSupportOk) btn.classList.add('disabled');
    }, 2500);
  } catch (e) {
    appendLog('❌ 复制失败：' + e.message);
  }
}
const copyTemplate = copyTemplateOnly;

// ===================== 长截图 =====================
async function captureScreenshot() {
  const btn = document.getElementById('screenshotBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  if (isCapturing) {
    abortCapture = true;
    btn.textContent = '正在拼接';
    btn.disabled = true;
    return;
  }
  isCapturing = true;
  abortCapture = false;
  btn.textContent = '正在启动';
  btn.className = 'step-btn executing';
  btn.disabled = false;
  settingsBtn.disabled = true;
  let wasAborted = false;
  let bottomHandled = false;
  let finalCanvasHeight = 0;
  let screenshots = [];
  try {
    const tab = await getActiveTab();
    const tabId = tab.id;
    const CROP_START_RATIO = globalSettings.cropStartRatio;
    const CROP_END_RATIO = globalSettings.cropEndRatio;
    const CROP_LEFT_RATIO = globalSettings.cropLeftRatio;
    const CROP_RIGHT_RATIO = globalSettings.cropRightRatio;
    const SCROLL_DELAY = globalSettings.screenshotDelay;
    const MAX_SCROLLS = 9999;
    const initResult = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return new Promise((resolve) => {
          const viewportHeight = window.innerHeight;
          const dpr = window.devicePixelRatio || 1;
          window.scrollTo(0, 0);
          setTimeout(() => {
            resolve({
              viewportHeight,
              dpr,
              totalHeight: Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight
              )
            });
          }, 300);
        });
      }
    });
    let { viewportHeight, dpr, totalHeight } = initResult[0].result;
    let scrollY = 0;
    let screenshotCount = 0;
    let isFirst = true;
    finalCanvasHeight = totalHeight;
    async function captureAndWait(ignoreAbort = false) {
      let retries = 0;
      const MAX_RETRIES = 40;
      while (true) {
        if (!ignoreAbort && abortCapture) throw new Error('Aborted');
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          await new Promise(r => setTimeout(r, SCROLL_DELAY));
          return dataUrl;
        } catch (e) {
          if (e.message && e.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
            retries++;
            if (retries > MAX_RETRIES) throw new Error(`截图失败：超过最大重试次数${MAX_RETRIES}次`);
            let waitTime = retries === 1 ? 350 : retries <= 14 ? 50 : retries <= 24 ? 150 : 250;
            appendLog(`⚠️ 限流等待${waitTime}ms (${retries}/${MAX_RETRIES})`);
            await new Promise(r => setTimeout(r, waitTime));
          } else throw e;
        }
      }
    }
    while (screenshotCount < MAX_SCROLLS) {
      if (abortCapture && !bottomHandled) {
        wasAborted = true;
        try {
          const pageInfo = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => ({ scrollY: window.scrollY, viewportHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 })
          });
          const currentScrollY = pageInfo[0].result.scrollY;
          const currentViewport = pageInfo[0].result.viewportHeight;
          dpr = pageInfo[0].result.dpr;
          scrollY = currentScrollY;
          viewportHeight = currentViewport;
          const lastDataUrl = await captureAndWait(true);
          const cropStartPx = Math.ceil(viewportHeight * CROP_START_RATIO) * dpr;
          const cropEndPx = viewportHeight * dpr;
          screenshots.push({
            dataUrl: lastDataUrl,
            y: scrollY,
            cropStartPx,
            cropEndPx,
            isLast: true,
            viewportHeight
          });
          screenshotCount++;
          finalCanvasHeight = scrollY + viewportHeight;
          appendLog(`⏹️ 用户取消，画布高度修正为${finalCanvasHeight}px，无底部透明`);
        } catch (e) {
          console.error('取消截图捕获失败', e);
          if (screenshots.length > 0) {
            const lastFrame = screenshots[screenshots.length - 1];
            finalCanvasHeight = lastFrame.y + lastFrame.cropEndPx / dpr;
            appendLog(`⏹️ 取消时截最后一屏失败，画布高度修正为${Math.round(finalCanvasHeight)}px`);
          }
        }
        bottomHandled = true;
        break;
      }
      const pageInfo = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => ({ viewportHeight: window.innerHeight, totalHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) })
      });
      viewportHeight = pageInfo[0].result.viewportHeight;
      if (pageInfo[0].result.totalHeight > totalHeight) {
        totalHeight = pageInfo[0].result.totalHeight;
        appendLog(`📈 页面高度更新至${totalHeight}px`);
      }
      const cropStart = Math.ceil(viewportHeight * CROP_START_RATIO);
      const cropEnd = Math.ceil(viewportHeight * CROP_END_RATIO);
      const stepPixels = cropEnd - cropStart;
      const cropStartPx = cropStart * dpr;
      const cropEndPx = cropEnd * dpr;
      btn.textContent = `截图 (${String(screenshotCount + 1).padStart(2, '0')})`;
      const dataUrl = await captureAndWait();
      const thisCropStartPx = isFirst ? 0 : cropStartPx;
      const thisCropEndPx = cropEndPx;
      screenshots.push({
        dataUrl, y: scrollY, cropStartPx: thisCropStartPx, cropEndPx: thisCropEndPx,
        isLast: false, viewportHeight
      });
      screenshotCount++;
      isFirst = false;
      const remaining = totalHeight - (scrollY + viewportHeight);
      if (remaining <= stepPixels) {
        const bottomScroll = Math.max(0, totalHeight - viewportHeight);
        if (bottomScroll > scrollY) {
          await chrome.scripting.executeScript({ target: { tabId }, func: y => window.scrollTo(0, y), args: [bottomScroll] });
          await new Promise(r => setTimeout(r, SCROLL_DELAY));
          const lastDataUrl = await captureAndWait();
          screenshots.push({
            dataUrl, y: bottomScroll, cropStartPx, cropEndPx: viewportHeight * dpr,
            isLast: true, viewportHeight
          });
          screenshotCount++;
        } else screenshots[screenshots.length - 1].isLast = true;
        finalCanvasHeight = totalHeight;
        bottomHandled = true;
        appendLog(`🛑 完整截图，页面总高度${finalCanvasHeight}px`);
        break;
      }
      scrollY += stepPixels;
      if (scrollY > totalHeight - viewportHeight) scrollY = Math.max(0, totalHeight - viewportHeight);
      await chrome.scripting.executeScript({ target: { tabId }, func: y => window.scrollTo(0, y), args: [scrollY] });
      await new Promise(r => setTimeout(r, SCROLL_DELAY));
      const newH = await chrome.scripting.executeScript({ target: { tabId }, func: () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) });
      if (newH[0].result > totalHeight) totalHeight = newH[0].result;
    }
    if (!bottomHandled && screenshotCount >= MAX_SCROLLS && screenshots.length > 0) {
      const last = screenshots[screenshots.length - 1];
      if (last && last.viewportHeight) {
        last.cropEndPx = last.viewportHeight * dpr;
        last.isLast = true;
        finalCanvasHeight = last.y + last.viewportHeight;
        appendLog(`⚠️ 达到最大滚动次数，画布截断至${finalCanvasHeight}px`);
      } else finalCanvasHeight = scrollY + viewportHeight;
    }
    if (screenshots.length === 0) {
      btn.textContent = '已取消 (无截图)';
      btn.className = 'step-btn error';
      btn.disabled = false;
      appendLog('⏹️ 截图取消，未捕获任何画面');
      isCapturing = abortCapture = false;
      settingsBtn.disabled = false;
      setTimeout(() => resetButton('screenshotBtn', '截图保存'), 2000);
      return;
    }
    const images = await Promise.all(screenshots.map(item => new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ img, y: item.y, cropStartPx: item.cropStartPx, cropEndPx: item.cropEndPx });
      img.onerror = () => resolve(null);
      img.src = item.dataUrl;
    })));
    const validImages = images.filter(v => v !== null);
    if (validImages.length === 0) throw new Error('全部截图加载失败');
    let actualMaxBottom = 0;
    for (const frame of validImages) {
      const frameBottom = frame.y + frame.cropEndPx / dpr;
      if (frameBottom > actualMaxBottom) actualMaxBottom = frameBottom;
    }
    if (finalCanvasHeight > actualMaxBottom) {
      finalCanvasHeight = actualMaxBottom;
    }
    const firstImg = validImages[0].img;
    const leftCropPx = Math.round(firstImg.width * CROP_LEFT_RATIO);
    const rightCropPx = Math.round(firstImg.width * CROP_RIGHT_RATIO);
    const cropWidthPx = rightCropPx - leftCropPx;
    const canvasWidth = cropWidthPx;
    const canvasHeight = finalCanvasHeight * dpr;
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    for (const frame of validImages) {
      const srcY = frame.cropStartPx;
      const srcH = frame.cropEndPx - frame.cropStartPx;
      const destY = frame.y * dpr + srcY;
      ctx.drawImage(frame.img,
        leftCropPx, srcY, cropWidthPx, srcH,
        0, destY, cropWidthPx, srcH
      );
    }
    const blob = await (await fetch(canvas.toDataURL('image/png'))).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    btn.textContent = '复制完成';
    btn.className = 'step-btn done';
    btn.disabled = false;
    appendLog(`📸 长截图${wasAborted ? '（中途取消已截断）' : '完成'}，共${validImages.length}段，画布${canvasWidth}x${canvasHeight}px`);
    setTimeout(() => resetButton('screenshotBtn', '截图保存'), 2500);
  } catch (e) {
    if (e.message === 'Aborted') {
      appendLog('⏹️ 截图已取消');
      btn.textContent = '已取消';
      btn.className = 'step-btn error';
    } else {
      console.error('截图流程异常', e);
      btn.textContent = '截图失败';
      btn.className = 'step-btn error';
      appendLog('❌ 长截图失败：' + e.message);
    }
    btn.disabled = false;
  } finally {
    isCapturing = false;
    abortCapture = false;
    settingsBtn.disabled = false;
  }
}

async function executeSelection() {
  if (!isSupportOk) return;
  const responseText = document.getElementById('aiResponse')?.value.trim() || '';
  if (!responseText) {
    appendLog('❌ 请先粘贴AI返回的指令');
    return;
  }
  const executeBtn = document.getElementById('executeBtn');
  if (executeBtn?.classList.contains('error') || executeBtn?.classList.contains('success-yellow')) {
    resetButton('executeBtn', '立即执行');
  }
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (e) {
    appendLog('❌ JSON 格式错误，请检查');
    setButtonState('executeBtn', '代码有误', 'error');
    setTimeout(() => resetButton('executeBtn', '立即执行'), 2000);
    return;
  }
  let info = lastExtractedInfo;
  if (!info) {
    info = await loadData();
    if (info) lastExtractedInfo = info;
  }
  if (!info) {
    appendLog('❌ 没有页面数据，请刷新页面后重试');
    return;
  }
  const tab = await getActiveTab();
  const entries = Object.entries(parsed);
  let totalSuccess = 0;
  let logLines = [];
  const isXuexitong = !!info.allQuestions;
  appendLog('⏳ 正在执行勾选...');
  setButtonState('executeBtn', '正在执行', 'executing');
  for (const [qNum, rawAnswer] of entries) {
    const number = parseInt(qNum);
    if (isNaN(number)) continue;
    const question = isXuexitong
      ? info.allQuestions.find(q => q.number === number)
      : info.allGroups.find(g => g.groupIndex === number);
    if (!question) {
      logLines.push(`⚠️ 题${number} 不存在（跳过）`);
      continue;
    }
    let normalized = normalizeAnswer(rawAnswer);
    let letters = [];
    if (typeof normalized === 'string') {
      letters = [normalized];
    } else if (Array.isArray(normalized)) {
      letters = normalized.map(a => a.toUpperCase());
    } else {
      logLines.push(`❌ 题${number} 答案格式不支持`);
      continue;
    }
    const result = await processQuestion(tab.id, question, letters, isXuexitong);
    if (isXuexitong) {
      totalSuccess += result.count;
      logLines.push(result.log);
    } else {
      totalSuccess += result;
      logLines.push(`题${number}: 已勾选 ${letters.join(',')}`);
    }
  }
  const summary = `✅ 成功勾选 ${totalSuccess} 个选项（涉及 ${entries.length} 道题）`;
  appendLog(summary);
  logLines.forEach(line => appendLog('  ' + line));
  setButtonState('executeBtn', '执行完毕', 'success-yellow');
  setTimeout(() => resetButton('executeBtn', '立即执行'), 2000);
}

// ===================== 页面初始化 =====================
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  updatePromptInputs();

  applyTheme(globalSettings.theme, false);
  setupSystemThemeListener();
  document.querySelectorAll('input[name="theme"]').forEach(radio => {
    radio.checked = radio.value === globalSettings.theme;
    radio.addEventListener('change', async (e) => {
      const newTheme = e.target.value;
      await saveSettings({ theme: newTheme });
      applyTheme(newTheme, true);
      if (newTheme === 'system') {
        setupSystemThemeListener();
      }
      appendLog(`🎨 主题已切换为：${newTheme === 'system' ? '跟随系统' : newTheme === 'dark' ? '深色' : '浅色'}`);
    });
  });

  document.querySelectorAll('input[name="delay"]').forEach(radio => {
    radio.checked = parseInt(radio.value) === globalSettings.clickDelay;
    radio.addEventListener('change', async (e) => {
      await saveSettings({ clickDelay: parseInt(e.target.value) });
      appendLog(`⚙️ 点击间隔已设置为 ${e.target.value}ms`);
    });
  });

  document.querySelectorAll('input[name="screenshotDelay"]').forEach(radio => {
    radio.checked = parseInt(radio.value) === globalSettings.screenshotDelay;
    radio.addEventListener('change', async (e) => {
      await saveSettings({ screenshotDelay: parseInt(e.target.value) });
      updateScreenshotDelayTip();
      appendLog(`📸 截图间隔已设置为 ${e.target.value}ms`);
    });
  });
  updateScreenshotDelayTip();

  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', toggleSettings);

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = {
    core: document.getElementById('tab-core'),
    screenshot: document.getElementById('tab-screenshot')
  };
  tabBtns.forEach(btn => {
    btn.addEventListener('click', async function() {
      tabBtns.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      Object.values(tabPanes).forEach(pane => pane.classList.remove('active'));
      const tabName = this.dataset.tab;
      if (tabPanes[tabName]) {
        tabPanes[tabName].classList.add('active');
      }
      if (tabName === 'screenshot') {
        updateRatioDisplay();
        await drawGuideLines();
      } else {
        await clearGuideLines(true);
      }
      const tabContent = document.querySelector('.tab-content');
      if (tabContent) tabContent.dispatchEvent(new Event('scroll'));
    });
  });

  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const targetType = btn.dataset.target;
        const isDown = btn.classList.contains('down');
        const step = 1;
        const startPct = Math.round(globalSettings.cropStartRatio * 100);
        const endPct = Math.round(globalSettings.cropEndRatio * 100);
        const leftPct = Math.round(globalSettings.cropLeftRatio * 100);
        const rightPct = Math.round(globalSettings.cropRightRatio * 100);
        let currentVal, newVal, saveKey, minVal, maxVal;
        switch (targetType) {
          case 'startRatio':
            currentVal = startPct;
            newVal = isDown ? currentVal + step : currentVal - step;
            newVal = Math.max(0, Math.min(endPct - 1, newVal));
            saveKey = 'cropStartRatio';
            break;
          case 'endRatio':
            currentVal = endPct;
            newVal = isDown ? currentVal + step : currentVal - step;
            newVal = Math.max(startPct + 1, Math.min(100, newVal));
            saveKey = 'cropEndRatio';
            break;
          case 'leftRatio':
            currentVal = leftPct;
            newVal = isDown ? currentVal + step : currentVal - step;
            newVal = Math.max(0, Math.min(rightPct - 1, newVal));
            saveKey = 'cropLeftRatio';
            break;
          case 'rightRatio':
            currentVal = rightPct;
            newVal = isDown ? currentVal + step : currentVal - step;
            newVal = Math.max(leftPct + 1, Math.min(100, newVal));
            saveKey = 'cropRightRatio';
            break;
          default:
            return;
        }
        const saveObj = {};
        saveObj[saveKey] = newVal / 100;
        await saveSettings(saveObj);
        updateRatioDisplay();
        const isScreenshotTab = document.getElementById('tab-screenshot')?.classList.contains('active');
        if (isScreenshotTab) await drawGuideLines();
        const labelMap = {
          startRatio: '起始线',
          endRatio: '步长线',
          leftRatio: '左边界',
          rightRatio: '右边界'
        };
        appendLog(`📐 ${labelMap[targetType] || targetType} 设为 ${newVal}%`);
      } catch (e) {
        console.error('比例调整失败:', e);
        appendLog('❌ 比例调整失败：' + e.message);
      }
    });
  });

  let saveTimer;
  const handlePromptChange = async () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await saveSettings({
        promptPrefix: document.getElementById('promptPrefix')?.value || '',
        promptSuffix: document.getElementById('promptSuffix')?.value || ''
      });
    }, 300);
  };
  const pre = document.getElementById('promptPrefix');
  const suf = document.getElementById('promptSuffix');
  if (pre) pre.addEventListener('input', handlePromptChange);
  if (suf) suf.addEventListener('input', handlePromptChange);

  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) resetBtn.addEventListener('click', resetToDefault);

  const copyBtn = document.getElementById('copyPromptBtn');
  if (copyBtn) copyBtn.addEventListener('click', copyPrompt);

  const execBtn = document.getElementById('executeBtn');
  if (execBtn) execBtn.addEventListener('click', executeSelection);

  const logToggle = document.getElementById('logToggle');
  if (logToggle) {
    logToggle.addEventListener('click', function () {
      const container = document.getElementById('logContainer');
      isLogOpen = !isLogOpen;
      container.classList.toggle('open', isLogOpen);
      this.textContent = isLogOpen ? '▲ 隐藏日志' : '▼ 展开日志';
    });
  }

  const templateBtn = document.getElementById('copyTemplateBtn');
  if (templateBtn) templateBtn.addEventListener('click', copyTemplateOnly);

  const screenshotBtn = document.getElementById('screenshotBtn');
  if (screenshotBtn) screenshotBtn.addEventListener('click', captureScreenshot);

  async function handleTabActivated(activeInfo) {
    await clearGuideLines(true);
  }
  chrome.tabs.onActivated.addListener(handleTabActivated);

  window.addEventListener('beforeunload', function() {
    console.log('🔄 popup 即将关闭，断开连接');
    if (popupPort) {
      try {
        popupPort.disconnect();
        console.log('✅ 连接已断开');
      } catch (e) {
        console.warn('断开连接失败:', e);
      }
    }
    if (systemThemeListener) {
      systemThemeListener.removeListener();
      systemThemeListener = null;
    }
    chrome.tabs.onActivated.removeListener(handleTabActivated);
  });

  try {
    const tab = await getActiveTab();
    if (tab && tab.id) {
      popupPort = chrome.tabs.connect(tab.id, { name: 'popup-connection' });
      console.log('✅ popup 与 content 连接已建立');
    }
  } catch (e) {
    console.debug('建立连接失败（可能页面不支持）:', e);
  }

  await autoExtract();

  const tabContent = document.querySelector('.tab-content');
  const tabMask = document.querySelector('.tab-mask');
  if (tabContent && tabMask) {
    const updateMask = () => {
      const { scrollTop, scrollHeight, clientHeight } = tabContent;
      const maxScroll = scrollHeight - clientHeight;
      if (maxScroll <= 0) {
        tabMask.style.opacity = '0';
        return;
      }
      const progress = scrollTop / maxScroll;
      let opacity = 1 - progress;
      opacity = Math.max(0, Math.min(1, opacity));
      tabMask.style.opacity = opacity;
    };
    tabContent.addEventListener('scroll', updateMask);
    updateMask();
  }
});