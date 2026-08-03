let lastExtractedInfo = null;
let promptText = '';
const STORAGE_KEY = 'aiHelperData';
const SETTINGS_KEY = 'helperSettings';
let isLogOpen = false;
let isSupportOk = false;
let currentMode = 'checkbox';
let globalSettings = {};

// 截图控制标志
let isCapturing = false;
let abortCapture = false;

// 全局统一默认提示词
const NEW_PREFIX = `请根据我提供的页面文字/图片/文件，仅识别出支持的三种题型（选择/判断/多选题）的题目和选项，并给出正确答案。返回答案格式为JSON，键为题目序号（从第1个支持的题目开始），值为对应字母（如"A"）。多选用数组表示，例如 {"3": ["A","C"]}。判断题请返回 "A"（对）或 "B"（错）。
页面内容如下：`;
const NEW_SUFFIX = `只返回仅作答选择/判断/多选题的答案JSON，不要其他文字。示例：{"1":"B","2":["A","C"],"3":"A"}`;

const DEFAULT_SETTINGS = {
  clickDelay: 25,
  promptPrefix: NEW_PREFIX,
  promptSuffix: NEW_SUFFIX,
  screenshotDelay: 500,
  cropStartRatio: 0.2,
  cropEndRatio: 0.8
};

// ========== 工具函数 ==========
function formatQuestionCount(count) {
  return String(count);
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
      if (globalSettings.cropStartRatio >= globalSettings.cropEndRatio) {
        globalSettings.cropEndRatio = Math.min(1, globalSettings.cropStartRatio + 0.1);
        if (globalSettings.cropEndRatio >= 1) {
          globalSettings.cropStartRatio = 0.2;
          globalSettings.cropEndRatio = 0.8;
        }
      }
      globalSettings.cropStartRatio = Math.min(1, Math.max(0, globalSettings.cropStartRatio));
      globalSettings.cropEndRatio = Math.min(1, Math.max(0, globalSettings.cropEndRatio));
      resolve(globalSettings);
    });
  });
}

async function saveSettings(newSettings) {
  Object.assign(globalSettings, newSettings);
  globalSettings.clickDelay = Number(globalSettings.clickDelay);
  globalSettings.screenshotDelay = Number(globalSettings.screenshotDelay);
  if (globalSettings.cropStartRatio >= globalSettings.cropEndRatio) {
    globalSettings.cropEndRatio = Math.min(1, globalSettings.cropStartRatio + 0.1);
    if (globalSettings.cropEndRatio >= 1) {
      globalSettings.cropStartRatio = 0.2;
      globalSettings.cropEndRatio = 0.8;
    }
  }
  globalSettings.cropStartRatio = Math.min(1, Math.max(0, globalSettings.cropStartRatio));
  globalSettings.cropEndRatio = Math.min(1, Math.max(0, globalSettings.cropEndRatio));
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

// ========== 核心功能 ==========
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
  const result = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (q) => window.getCurrentSelected(q),
    args: [question]
  });
  return result?.[0]?.result || [];
}

async function clickOption(tabId, selector, isXuexitong) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
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

// ========== UI 函数 ==========
function setStatus(text, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  const allowTexts = ['提取成功，共', '未找到任何题目，请确认页面已加载完成。'];
  const isAllow = allowTexts.some(s => text.includes(s));
  if (isAllow) {
    el.textContent = text;
    el.style.color = isError ? '#d32f2f' : '#333';
  } else {
    el.textContent = '';
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

function setSupportStatus(success, type = '') {
  const el = document.getElementById('supportStatus');
  if (!el) return;
  if (success) {
    currentMode = type;
    el.textContent = type === 'xuexitong' ? '✅ 学习通页' : '✅ 复选框页';
    el.className = 'step-status success';
  } else {
    el.textContent = '❌ 非支持页';
    el.className = 'step-status fail';
  }
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

// ========== 设置面板交互 ==========
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
      updatePromptInputs();
      document.querySelector('.tab-btn[data-tab="core"]')?.click();
    }, 300);
  } else {
    panelDom.classList.add('fade-out');
    setTimeout(() => {
      panelDom.classList.add('hidden');
      main.classList.remove('hidden');
      setTimeout(() => main.classList.remove('fade-out'), 10);
      btn.textContent = '⚙️ 设置';
      clearGuideLines();
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
  updateRatioInputs();
  updateScreenshotDelayTip();
  updatePromptInputs();
  appendLog('✅ 已恢复默认设置，提示词重置完成');
}

// ========== 截图间隔提示更新 ==========
function updateScreenshotDelayTip() {
  const tip = document.getElementById('screenshotDelayTip');
  const checked = document.querySelector('input[name="screenshotDelay"]:checked');
  if (!checked || !tip) return;
  const val = parseInt(checked.value);
  let text = '', cls = '';
  if (val <= 100) {
    text = '⚠️ 可能会导致浏览器出错';
    cls = 'danger';
  } else if (val === 500) {
    text = '✅ 标准速度';
    cls = 'success';
  } else {
    text = '⏳ 页面加载较慢时使用';
    cls = 'warn';
  }
  tip.textContent = text;
  tip.className = 'delay-tip ' + cls;
}

// ========== 比例输入框同步 ==========
function updateRatioInputs() {
  const startInput = document.getElementById('startRatioInput');
  const endInput = document.getElementById('endRatioInput');
  if (startInput) startInput.value = Math.round(globalSettings.cropStartRatio * 100);
  if (endInput) endInput.value = Math.round(globalSettings.cropEndRatio * 100);
  updateRatioDisplay();
}

function updateRatioDisplay() {
  const startPct = Math.round(globalSettings.cropStartRatio * 100);
  const endPct = Math.round(globalSettings.cropEndRatio * 100);
  document.getElementById('startRatioDisplay').textContent = startPct + '%';
  document.getElementById('endRatioDisplay').textContent = endPct + '%';
  document.getElementById('stepDisplay').textContent = (endPct - startPct) + '%';
}

// ========== 辅助线绘制（与 content script 通信） ==========
async function drawGuideLines() {
  try {
    const tab = await getActiveTab();
    if (!tab.id) return;
    const url = tab.url || '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    const injected = await ensureContentScript();
    if (!injected) return;
    await chrome.tabs.sendMessage(tab.id, {
      action: 'drawLines',
      startRatio: globalSettings.cropStartRatio,
      endRatio: globalSettings.cropEndRatio
    });
    updateRatioDisplay();
  } catch (e) {
    console.debug('绘制辅助线失败:', e);
  }
}

async function clearGuideLines() {
  try {
    const tab = await getActiveTab();
    if (!tab.id) return;
    const url = tab.url || '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    const injected = await ensureContentScript();
    if (!injected) return;
    await chrome.tabs.sendMessage(tab.id, { action: 'clearLines' });
  } catch (e) {
    console.debug('清除辅助线失败:', e);
  }
}

// ========== 业务流程 ==========
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

// ========== 长截图（支持取消，正确截断高度） ==========
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

  try {
    const tab = await getActiveTab();
    const tabId = tab.id;

    const CROP_START_RATIO = globalSettings.cropStartRatio;
    const CROP_END_RATIO = globalSettings.cropEndRatio;
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
    const screenshots = [];
    let isFirst = true;
    let wasAborted = false;
    let finalCanvasHeight = totalHeight;

    // 支持配额错误重试（固定间隔 75ms，最多 100 次）
    // 支持配额错误重试（分段等待策略）
async function captureAndWait() {
  let retries = 0;
  const MAX_RETRIES = 40; // 总重试次数

  while (true) {
    if (abortCapture) {
      throw new Error('Aborted');
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      // 截图成功后保留原有的滚动间隔
      await new Promise(r => setTimeout(r, SCROLL_DELAY));
      return dataUrl;
    } catch (e) {
      if (e.message && e.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        retries++;
        if (retries > MAX_RETRIES) {
          throw new Error(`截图失败：超过最大重试次数（${MAX_RETRIES}次），请检查网络或浏览器限制`);
        }

        // ----- 分段计算等待时间 -----
        let waitTime;
        if (retries === 1) {
          waitTime = 350;
        } else if (retries >= 2 && retries <= 14) {   // 共 13 次（2~14）
          waitTime = 50;
        } else if (retries >= 15 && retries <= 24) { // 共 10 次（15~24）
          waitTime = 150;
        } else { // retries >= 25 && retries <= 40  // 共 16 次
          waitTime = 250;
        }

        appendLog(`⚠️ 截图速率限制，等待 ${waitTime}ms 后重试 (${retries}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitTime));
      } else {
        throw e;
      }
    }
  }
}

    let bottomHandled = false;

    while (screenshotCount < MAX_SCROLLS) {
      if (abortCapture && !bottomHandled) {
        wasAborted = true;
        try {
          const pageInfo = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => ({
              viewportHeight: window.innerHeight,
              dpr: window.devicePixelRatio || 1
            })
          });
          const currentViewport = pageInfo[0].result.viewportHeight;
          const currentDpr = pageInfo[0].result.dpr;
          dpr = currentDpr;
          viewportHeight = currentViewport;

          const lastDataUrl = await captureAndWait();
          const cropStart = Math.ceil(viewportHeight * CROP_START_RATIO);
          const cropStartPx = cropStart * dpr;
          const cropEndPx = viewportHeight * dpr;
          screenshots.push({
            dataUrl: lastDataUrl,
            y: scrollY,
            cropStartPx: cropStartPx,
            cropEndPx: cropEndPx,
            isLast: true,
            viewportHeight: viewportHeight  // ✅ 新增
          });
          screenshotCount++;
          finalCanvasHeight = scrollY + viewportHeight;
          appendLog(`⏹️ 用户取消，当前视口作为最后一帧截取，最终高度=${finalCanvasHeight}px`);
        } catch (e) {
          console.error('取消时截图失败:', e);
        }
        bottomHandled = true;
        break;
      }

      const pageInfo = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => ({
          viewportHeight: window.innerHeight,
          totalHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
        })
      });
      const currentViewport = pageInfo[0].result.viewportHeight;
      const currentTotal = pageInfo[0].result.totalHeight;

      viewportHeight = currentViewport;
      if (currentTotal > totalHeight) {
        totalHeight = currentTotal;
        appendLog(`📈 页面高度增长至 ${totalHeight}px`);
      }

      const cropStart = Math.ceil(viewportHeight * CROP_START_RATIO);
      const cropEnd = Math.ceil(viewportHeight * CROP_END_RATIO);
      const stepPixels = cropEnd - cropStart;

      const cropStartPx = cropStart * dpr;
      const cropEndPx = cropEnd * dpr;

      const countDisplay = String(screenshotCount + 1).padStart(2, '0');
      btn.textContent = `截图 (${countDisplay})`;

      const dataUrl = await captureAndWait();

      let thisCropStartPx, thisCropEndPx;
      if (isFirst) {
        thisCropStartPx = 0;
        thisCropEndPx = cropEndPx;
      } else {
        thisCropStartPx = cropStartPx;
        thisCropEndPx = cropEndPx;
      }

      screenshots.push({
        dataUrl,
        y: scrollY,
        cropStartPx: thisCropStartPx,
        cropEndPx: thisCropEndPx,
        isLast: false,
        viewportHeight: viewportHeight  // ✅ 新增
      });
      screenshotCount++;
      isFirst = false;

      if (abortCapture && !bottomHandled) {
        continue;
      }

      const remaining = totalHeight - (scrollY + viewportHeight);
      if (remaining <= stepPixels) {
        const bottomScroll = Math.max(0, totalHeight - viewportHeight);
        if (bottomScroll > scrollY) {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (y) => window.scrollTo(0, y),
            args: [bottomScroll]
          });
          await new Promise(r => setTimeout(r, SCROLL_DELAY));

          const lastDataUrl = await captureAndWait();
          const lastCropStartPx = cropStartPx;
          const lastCropEndPx = viewportHeight * dpr;
          screenshots.push({
            dataUrl: lastDataUrl,
            y: bottomScroll,
            cropStartPx: lastCropStartPx,
            cropEndPx: lastCropEndPx,
            isLast: true,
            viewportHeight: viewportHeight  // ✅ 新增
          });
          screenshotCount++;
          finalCanvasHeight = totalHeight;
        } else {
          screenshots[screenshots.length - 1].isLast = true;
          finalCanvasHeight = totalHeight;
        }
        bottomHandled = true;
        appendLog(`🛑 剩余高度不足步长，截取底部后停止`);
        break;
      }

      scrollY += stepPixels;
      if (scrollY > totalHeight - viewportHeight) {
        scrollY = Math.max(0, totalHeight - viewportHeight);
      }

      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (y) => window.scrollTo(0, y),
        args: [scrollY]
      });

      await new Promise(r => setTimeout(r, SCROLL_DELAY));

      const afterScroll = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
      });
      const newTotal = afterScroll[0].result;
      if (newTotal > totalHeight) {
        totalHeight = newTotal;
        appendLog(`📈 滚动后高度增长至 ${totalHeight}px`);
      }
    }

    // ✅ 修正：因达到最大次数强制停止时，截断画布至实际截取区域
    if (!bottomHandled && screenshotCount >= MAX_SCROLLS && screenshots.length > 0) {
      const last = screenshots[screenshots.length - 1];
      if (last && last.viewportHeight) {
        // 将最后一个截图的裁剪结束位置修正为视口底部（原为起始线到步长线）
        last.cropEndPx = last.viewportHeight * dpr;
        last.isLast = true;
        finalCanvasHeight = last.y + last.viewportHeight;
        appendLog(`⚠️ 达到最大滚动次数 (${MAX_SCROLLS})，画布高度截断为 ${finalCanvasHeight}px`);
      } else {
        // 降级处理：使用当前滚动位置+视口高度
        finalCanvasHeight = scrollY + viewportHeight;
        appendLog(`⚠️ 达到最大滚动次数，使用降级高度 ${finalCanvasHeight}px`);
      }
    }

    if (screenshots.length === 0) {
      btn.textContent = '已取消 (无截图)';
      btn.className = 'step-btn error';
      btn.disabled = false;
      appendLog('⏹️ 截图被取消（无已截取内容）');
      isCapturing = false;
      abortCapture = false;
      settingsBtn.disabled = false;
      setTimeout(() => {
        btn.textContent = '截图保存';
        btn.className = 'step-btn';
        btn.disabled = false;
      }, 2000);
      return;
    }

    const images = await Promise.all(
      screenshots.map(({ dataUrl, y, cropStartPx, cropEndPx }) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ img, y, cropStartPx, cropEndPx });
          img.onerror = () => resolve(null);
          img.src = dataUrl;
        });
      })
    );

    const validImages = images.filter(img => img !== null);
    if (validImages.length === 0) throw new Error('所有截图加载失败');

    const firstImg = validImages[0].img;
    const canvasWidth = firstImg.width;
    const canvasHeight = finalCanvasHeight * dpr;

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < validImages.length; i++) {
      const { img, y, cropStartPx, cropEndPx } = validImages[i];
      const srcY = cropStartPx;
      const srcHeight = cropEndPx - cropStartPx;
      const destY = y * dpr + srcY;
      ctx.drawImage(img, 0, srcY, img.width, srcHeight, 0, destY, img.width, srcHeight);
    }

    const finalDataUrl = canvas.toDataURL('image/png');
    const response = await fetch(finalDataUrl);
    const blob = await response.blob();

    const clipboardItem = new ClipboardItem({ [blob.type]: blob });
    await navigator.clipboard.write([clipboardItem]);

    btn.textContent = '复制完成';
    btn.className = 'step-btn done';
    btn.disabled = false;
    appendLog(`📸 长截图${wasAborted ? '被取消（高度截断至当前视口底部）' : '完成'}（共 ${validImages.length} 段，dpr=${dpr}，高度=${canvasHeight}px）`);

    setTimeout(() => {
      btn.textContent = '截图保存';
      btn.className = 'step-btn';
      btn.disabled = false;
    }, 2500);

  } catch (e) {
    console.error('截图失败:', e);
    btn.textContent = '截图失败';
    btn.className = 'step-btn error';
    btn.disabled = false;
    appendLog('❌ 长截图失败：' + e.message);
  } finally {
    isCapturing = false;
    abortCapture = false;
    settingsBtn.disabled = false;
  }
}

// ========== 执行勾选 ==========
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

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();

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
    btn.addEventListener('click', function() {
      tabBtns.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      Object.values(tabPanes).forEach(pane => pane.classList.remove('active'));
      const tabName = this.dataset.tab;
      if (tabPanes[tabName]) {
        tabPanes[tabName].classList.add('active');
      }
      if (tabName === 'screenshot') {
        updateRatioInputs();
        drawGuideLines();
      } else {
        clearGuideLines();
      }
    });
  });

  const startInput = document.getElementById('startRatioInput');
  const endInput = document.getElementById('endRatioInput');
  if (startInput) {
    startInput.value = Math.round(globalSettings.cropStartRatio * 100);
    startInput.addEventListener('change', async function() {
      let val = parseFloat(this.value);
      if (isNaN(val)) val = 20;
      val = Math.min(100, Math.max(0, val));
      let endVal = parseFloat(endInput.value);
      if (isNaN(endVal)) endVal = 80;
      if (val >= endVal) {
        val = Math.min(val - 1, endVal - 1);
        if (val < 0) val = 0;
        this.value = val;
        appendLog('⚠️ 起始线必须小于步长线，已自动调整');
      }
      await saveSettings({ cropStartRatio: val / 100 });
      updateRatioDisplay();
      const isScreenshotTab = document.getElementById('tab-screenshot').classList.contains('active');
      if (isScreenshotTab) drawGuideLines();
      appendLog(`📐 起始线设为 ${val}%`);
    });
  }
  if (endInput) {
    endInput.value = Math.round(globalSettings.cropEndRatio * 100);
    endInput.addEventListener('change', async function() {
      let val = parseFloat(this.value);
      if (isNaN(val)) val = 80;
      val = Math.min(100, Math.max(0, val));
      let startVal = parseFloat(startInput.value);
      if (isNaN(startVal)) startVal = 20;
      if (val <= startVal) {
        val = Math.min(val + 1, startVal + 1);
        if (val > 100) val = 100;
        this.value = val;
        appendLog('⚠️ 步长线必须大于起始线，已自动调整');
      }
      await saveSettings({ cropEndRatio: val / 100 });
      updateRatioDisplay();
      const isScreenshotTab = document.getElementById('tab-screenshot').classList.contains('active');
      if (isScreenshotTab) drawGuideLines();
      appendLog(`📐 步长线设为 ${val}%`);
    });
  }

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

  function handleTabActivated(activeInfo) {
    clearGuideLines();
  }
  chrome.tabs.onActivated.addListener(handleTabActivated);

  window.addEventListener('beforeunload', function() {
    chrome.tabs.onActivated.removeListener(handleTabActivated);
  });

  try {
    const tab = await getActiveTab();
    if (tab && tab.id) {
      const port = chrome.tabs.connect(tab.id, { name: 'popup-connection' });
    }
  } catch (e) {
    console.debug('建立连接失败（可能页面不支持）:', e);
  }

  await autoExtract();
});