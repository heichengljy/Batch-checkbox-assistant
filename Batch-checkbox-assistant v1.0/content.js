console.log('批量答题助手 content script 加载（支持学习通考试页面、通用复选框）');

// ========== 通用安全选择器工具 ==========
function safeQuerySelector(selector) {
  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    return document.getElementById(id);
  } else if (selector.startsWith('__index_')) {
    const index = parseInt(selector.split('_')[2]);
    const allInputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    return allInputs[index] || null;
  } else {
    return document.querySelector(selector);
  }
}

// ========== 学习通专属逻辑 ==========
function extractXuexitong() {
  const questionDivs = document.querySelectorAll('div.questionLi');
  if (!questionDivs || questionDivs.length === 0) {
    return { error: '未找到任何题目，请确认页面已加载完成。' };
  }
  const allQuestions = [];
  questionDivs.forEach((qDiv) => {
    const titleEl = qDiv.querySelector('h3.mark_name');
    let qNumber = 0;
    let qTitle = '';
    if (titleEl) {
      const text = titleEl.textContent.trim();
      const match = text.match(/^(\d+)[、\.]\s*/);
      if (match) qNumber = parseInt(match[1]);
      const contentDiv = titleEl.querySelector('div');
      if (contentDiv) {
        qTitle = contentDiv.textContent.trim();
      } else {
        let raw = text.replace(/^(\d+)[、\.]\s*/, '').replace(/\([^)]*\)\s*/, '').trim();
        qTitle = raw;
      }
    }
    if (!qNumber) return;
    const optionDivs = qDiv.querySelectorAll('div.clearfix.answerBg');
    const options = [];
    optionDivs.forEach((optDiv) => {
      const span = optDiv.querySelector('span.num_option, span.num_option_dx');
      if (!span) return;
      const letter = span.getAttribute('data') || span.textContent.trim();
      if (!letter) return;
      const textDiv = optDiv.querySelector('div.fl.answer_p');
      const text = textDiv ? textDiv.textContent.trim() : '';
      const parentData = qDiv.getAttribute('data');
      if (!parentData) return;
      const selector = `div.questionLi[data="${parentData}"] div.clearfix.answerBg span[data="${letter}"]`;
      options.push({
        letter: letter.trim(),
        label: text,
        selector: selector,
        questionId: parentData
      });
    });
    if (options.length === 0) return;
    allQuestions.push({
      number: qNumber,
      title: qTitle,
      options: options
    });
  });
  if (allQuestions.length === 0) {
    return { error: '未提取到有效题目，请检查页面格式。' };
  }
  console.log('学习通模式：提取到题目数量:', allQuestions.length);
  return {
    allQuestions: allQuestions,
    rawText: document.body.innerText,
    mode: 'xuexitong'
  };
}

function getCurrentSelectedXuexitong(question) {
  const selected = [];
  const questionId = question.options[0]?.questionId;
  if (!questionId) return selected;
  question.options.forEach(opt => {
    let span = document.querySelector(opt.selector);
    if (!span) {
      const allSpans = document.querySelectorAll(`span[data="${opt.letter}"]`);
      for (let s of allSpans) {
        const parentDiv = s.closest('div.questionLi');
        if (parentDiv && parentDiv.getAttribute('data') === questionId) {
          span = s;
          break;
        }
      }
    }
    if (span) {
      const isChecked = span.classList.contains('check_answer') || span.classList.contains('check_answer_dx');
      if (isChecked) {
        selected.push(opt.letter);
      }
    } else {
      console.warn(`未找到选项 ${opt.letter} 的元素`);
    }
  });
  return selected;
}

// ========== 通用复选框逻辑 ==========
function extractCheckbox() {
  function getAllVisibleText() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t) text += t + ' ';
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  const inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
  if (inputs.length === 0) {
    return { error: "未检测到任何单选框或复选框" };
  }
  const nameMap = new Map();
  inputs.forEach(inp => {
    const name = inp.name || `__unique_${Math.random()}`;
    if (!nameMap.has(name)) nameMap.set(name, []);
    nameMap.get(name).push(inp);
  });
  const groups = [];
  const seenNames = new Set();
  let groupIndex = 1;
  inputs.forEach(inp => {
    const name = inp.name || `__unique_${Math.random()}`;
    if (!seenNames.has(name)) {
      seenNames.add(name);
      const arr = nameMap.get(name);
      if (arr && arr.length > 0) {
        const options = arr.map((input, idx) => {
          let labelText = '';
          if (input.id) {
            const label = document.querySelector(`label[for="${input.id}"]`);
            if (label) labelText = label.textContent.trim();
          }
          if (!labelText) {
            let parent = input.parentElement;
            while (parent && parent.tagName !== 'LABEL' && parent !== document.body) {
              parent = parent.parentElement;
            }
            if (parent && parent.tagName === 'LABEL') {
              labelText = parent.textContent.trim();
            }
          }
          if (!labelText) {
            const parent = input.parentElement;
            if (parent) {
              const childNodes = parent.childNodes;
              for (let child of childNodes) {
                if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
                  labelText = child.textContent.trim();
                  break;
                }
                if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'INPUT') {
                  const txt = child.textContent.trim();
                  if (txt) {
                    labelText = txt;
                    break;
                  }
                }
              }
            }
          }
          if (!labelText) {
            labelText = input.value || input.placeholder || `选项${String.fromCharCode(65 + idx)}`;
          }
          labelText = labelText.replace(/\s+/g, ' ').trim();
          const letter = String.fromCharCode(65 + idx);
          let selector = '';
          if (input.id) {
            selector = `#${input.id}`;
          } else {
            const nameVal = input.name;
            const val = input.value;
            if (nameVal && val) {
              selector = `input[name="${nameVal}"][value="${val}"]`;
            } else {
              const allInputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
              const index = Array.from(allInputs).indexOf(input);
              if (index !== -1) selector = `__index_${index}`;
            }
          }
          return {
            letter: letter,
            label: labelText,
            selector: selector,
            element: input
          };
        });
        groups.push({
          groupIndex: groupIndex++,
          options: options
        });
      }
    }
  });
  const rawText = getAllVisibleText();
  console.log('复选框模式：提取到题目组数:', groups.length);
  return {
    rawText: rawText,
    allGroups: groups,
    mode: 'checkbox'
  };
}

function getCurrentSelectedCheckbox(group) {
  const selected = [];
  group.options.forEach(opt => {
    const input = safeQuerySelector(opt.selector);
    if (input && input.checked) {
      selected.push(opt.letter);
    }
  });
  return selected;
}

// ========== 统一入口 ==========
window.extractPageInfo = function() {
  const xuexitongResult = extractXuexitong();
  if (xuexitongResult.allQuestions && xuexitongResult.allQuestions.length > 0) {
    console.log('检测到学习通考试界面，启用学习通专属逻辑');
    return xuexitongResult;
  }
  const checkboxResult = extractCheckbox();
  if (checkboxResult.allGroups && checkboxResult.allGroups.length > 0) {
    console.log('检测到通用复选框界面，启用通用逻辑');
    return checkboxResult;
  }
  return {
    error: xuexitongResult.error || checkboxResult.error || '未检测到有效题目或复选框'
  };
};

window.getCurrentSelected = function(target) {
  if (target.options && target.options[0] && target.options[0].questionId) {
    return getCurrentSelectedXuexitong(target);
  } else {
    return getCurrentSelectedCheckbox(target);
  }
};

// ========== 辅助线绘制 ==========
let guideLines = [];
let _fadeTimeout = null;

function drawLines(startRatio, endRatio) {
  clearLines(true); // 立即清除旧线，打断动画
  const startTop = startRatio * window.innerHeight;
  const endTop = endRatio * window.innerHeight;

  const startLine = document.createElement('div');
  startLine.style.cssText = `
    position: fixed;
    top: ${startTop}px;
    left: 0;
    width: 100%;
    height: 2px;
    background-color: red;
    z-index: 999999;
    pointer-events: none;
  `;
  const endLine = document.createElement('div');
  endLine.style.cssText = `
    position: fixed;
    top: ${endTop}px;
    left: 0;
    width: 100%;
    height: 2px;
    background-color: blue;
    z-index: 999999;
    pointer-events: none;
  `;
  document.body.appendChild(startLine);
  document.body.appendChild(endLine);
  guideLines.push(startLine, endLine);
}

// ========== clearLines 支持 immediate 参数 ==========
function clearLines(immediate = false) {
  console.log('🧹 clearLines 被调用, immediate:', immediate);

  // 清除之前的动画定时器（打断动画）
  if (_fadeTimeout) {
    clearTimeout(_fadeTimeout);
    _fadeTimeout = null;
    console.log('⏹️ 中断之前的淡出动画');
  }

  const container = document.getElementById('helper-lines-container');
  if (container) {
    if (immediate) {
      // 立即清除
      container.remove();
      document.querySelectorAll('div[style*="position: fixed"][style*="z-index: 999999"]').forEach(el => {
        if (el.style.backgroundColor === 'red' || el.style.backgroundColor === 'blue' ||
            el.style.borderTopColor === 'red' || el.style.borderTopColor === 'blue' ||
            el.style.borderLeftColor === 'red' || el.style.borderLeftColor === 'blue') {
          el.remove();
        }
      });
      guideLines = [];
      console.log('✅ 容器立即清除');
    } else {
      // 播放淡出动画
      console.log('🎬 播放淡出动画 (3s)');
      container.style.transition = 'opacity 3s ease';
      container.style.opacity = '0';
      _fadeTimeout = setTimeout(() => {
        if (container.parentNode) container.remove();
        document.querySelectorAll('div[style*="position: fixed"][style*="z-index: 999999"]').forEach(el => {
          if (el.style.backgroundColor === 'red' || el.style.backgroundColor === 'blue' ||
              el.style.borderTopColor === 'red' || el.style.borderTopColor === 'blue' ||
              el.style.borderLeftColor === 'red' || el.style.borderLeftColor === 'blue') {
            el.remove();
          }
        });
        guideLines = [];
        _fadeTimeout = null;
        console.log('✅ 容器淡出并移除完成');
      }, 3000);
    }
    return;
  }

  // 无容器时执行旧版清除（立即）
  guideLines.forEach(el => el.remove());
  guideLines = [];
  document.querySelectorAll('div[style*="position: fixed"][style*="z-index: 999999"]').forEach(el => {
    if (el.style.backgroundColor === 'red' || el.style.backgroundColor === 'blue' ||
        el.style.borderTopColor === 'red' || el.style.borderTopColor === 'blue' ||
        el.style.borderLeftColor === 'red' || el.style.borderLeftColor === 'blue') {
      el.remove();
    }
  });
  console.log('✅ 旧版线条已清除（无容器）');
}

// ========== 消息监听 ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'drawLines') {
    drawLines(message.startRatio, message.endRatio);
    sendResponse({ status: 'ok' });
  } else if (message.action === 'clearLines') {
    clearLines(message.immediate || false);
    sendResponse({ status: 'ok' });
  }
  return true;
});

// ========== 监听 popup 连接 ==========
chrome.runtime.onConnect.addListener(function(port) {
  if (port.name === 'popup-connection') {
    console.log('✅ popup 连接已建立');
    port.onDisconnect.addListener(function() {
      console.log('⚠️ popup 连接已断开，自动清除辅助线');
      clearLines(); // 默认 false，播放动画
    });
  }
});