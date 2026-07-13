// 自包含 trace viewer 的 HTML 模板。每次启动由 Tracer 重写入 traces 目录，
// 与 trace-data.js 同处；双击即可打开（数据经 <script src> 加载，规避 file:// 的 fetch 限制）。
// 无任何外部依赖 / 构建步骤。改这里后下次 npm start 自动生效（Tracer 每次启动重写）。
//
// 四层结构全部用 <details> 可折叠：Session → Turn → Step(LLM) → ToolCall。
//   - Session 默认展开，Turn 仅最后一轮展开，Step 默认展开，ToolCall 默认收起
//     （工具结果通常很长，收起后只看摘要行，点开再看 arguments/result）。
//   - 顶部「全部展开 / 全部收起」一键切换所有层级。

export const VIEWER_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>mcc · trace</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1e222b; --border: #2a2f3a;
    --fg: #e6e9ef; --dim: #8b93a3; --accent: #7aa2f7; --green: #9ece6a;
    --red: #f7768e; --yellow: #e0af68; --purple: #bb9af7;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 24px 16px 80px; }
  .topbar { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 18px; margin: 0; }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 16px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 18px; }
  .btn {
    background: var(--panel2); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  .btn:hover { background: var(--panel); border-color: var(--accent); }
  .flt { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; margin-right: auto; }
  select {
    background: var(--panel2); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer;
  }
  select:hover { border-color: var(--accent); }
  .empty { color: var(--dim); padding: 40px; text-align: center; border: 1px dashed var(--border); border-radius: 8px; }

  /* ---- 通用 details / summary ---- */
  details { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  summary {
    list-style: none; cursor: pointer; display: flex; align-items: center;
    gap: 10px; user-select: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary:hover { filter: brightness(1.12); }
  .chev {
    color: var(--dim); transition: transform .15s; display: inline-block;
    width: 12px; text-align: center; flex: none;
  }
  details[open] > summary .chev { transform: rotate(90deg); }
  .ms { color: var(--dim); font-family: ui-monospace, monospace; font-size: 12px; white-space: nowrap; }
  .tok { color: var(--dim); font-size: 12px; white-space: nowrap; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
  .badge.ok { background: rgba(158,206,106,.15); color: var(--green); }
  .badge.error { background: rgba(247,118,142,.15); color: var(--red); }
  .badge.truncated { background: rgba(224,175,104,.15); color: var(--yellow); }
  .badge.interrupted { background: rgba(224,175,104,.15); color: var(--yellow); }
  .count { color: var(--dim); font-size: 11px; white-space: nowrap; }

  /* ---- 时间线 waterfall ---- */
  .track {
    position: relative; flex: 1; min-width: 60px; height: 8px;
    background: var(--panel2); border-radius: 4px; overflow: hidden;
  }
  .seg { position: absolute; top: 0; height: 8px; border-radius: 3px; min-width: 2px; }
  .seg.llm { background: var(--accent); }
  .seg.tool { background: var(--purple); }
  .legend { display: flex; align-items: center; gap: 14px; padding: 2px 6px 6px; font-size: 11px; color: var(--dim); }
  .lg { display: inline-flex; align-items: center; gap: 5px; }
  .lg::before { content: ''; width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .lg-llm::before { background: var(--accent); }
  .lg-tool::before { background: var(--purple); }
  .axis { margin-left: auto; font-family: ui-monospace, monospace; }

  /* ---- Session ---- */
  .session { margin-bottom: 22px; }
  .session > summary {
    background: var(--panel2); padding: 12px 16px; flex-wrap: wrap; gap: 6px 14px; align-items: baseline;
  }
  .session > summary .chev { align-self: center; }
  .sid { font-weight: 600; color: var(--accent); font-family: ui-monospace, monospace; }
  .model { color: var(--purple); }
  .stat { color: var(--dim); font-size: 12px; }
  .stat b { color: var(--fg); font-weight: 600; }
  .sbody { padding: 6px; display: flex; flex-direction: column; gap: 6px; }

  /* ---- Turn ---- */
  .turn { border-color: var(--border); background: var(--bg); }
  .turn > summary { padding: 10px 14px; background: var(--panel); }
  .uin { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .tbody { padding: 8px; display: flex; flex-direction: column; gap: 6px; }

  /* ---- Step (LLM 调用) ---- */
  .step { background: var(--panel); border-color: var(--border); }
  .step > summary { padding: 8px 12px; }
  .step-title { font-weight: 600; flex: none; }
  .step-title .fr { color: var(--dim); font-weight: 400; font-size: 12px; }
  .step-body { padding: 4px 12px 12px; }

  /* ---- 内容块 / 标签 ---- */
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); margin: 8px 0 3px; }
  .content {
    white-space: pre-wrap; word-break: break-word; background: var(--panel2);
    border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
    margin: 2px 0 4px; color: var(--fg); font-size: 13px;
  }
  .content.think { color: var(--dim); font-style: italic; }

  /* ---- Tool 调用 ---- */
  .tool { background: var(--panel2); border-color: var(--border); margin: 6px 0 0; }
  .tool.err { border-color: var(--red); }
  .tool > summary { padding: 7px 12px; }
  .tool-name { font-weight: 600; color: var(--purple); font-family: ui-monospace, monospace; flex: none; }
  .tool.err .tool-name { color: var(--red); }
  .tool-body { padding: 2px 12px 10px; }

  /* ---- Tool 内部的 arguments / result 子折叠块 ---- */
  .sub { border: none; border-radius: 0; overflow: visible; margin: 6px 0 0; }
  .sub > summary { padding: 0; gap: 6px; }
  .sub > summary .label { margin: 0; }
  .sub > summary .chev { width: 10px; }
  pre {
    margin: 2px 0; padding: 6px 8px; background: var(--bg); border-radius: 4px;
    overflow: auto; max-height: 340px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre; word-break: normal; color: #cbd2e0;
  }
  pre.args { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar"><h1>mcc · trace</h1></div>
  <div class="sub" id="sub">加载中…</div>
  <div class="toolbar" id="toolbar" style="display:none">
    <label class="flt">日期 <select id="dateFilter"><option value="all">全部日期</option></select></label>
    <button class="btn" id="expandAll">全部展开</button>
    <button class="btn" id="collapseAll">全部收起</button>
  </div>
  <div id="root"></div>
</div>
<script src="./trace-data.js"></script>
<script>
(function () {
  var root = document.getElementById('root');
  var sub = document.getElementById('sub');
  var toolbar = document.getElementById('toolbar');

  // 当前日期筛选（'all' 或 'YYYY-MM-DD'）
  var currentDate = 'all';
  // startedAt(ms) → 本地 YYYY-MM-DD
  function fmtDate(ms) {
    var d = new Date(ms);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtArgs(a) {
    try { return JSON.stringify(a, null, 2); } catch (e) { return String(a); }
  }
  function pct(v, max) { return max > 0 ? Math.max(2, (v / max) * 100) : 2; }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function render() {
  var all = window.__MCC_TRACE__;
  if (!Array.isArray(all) || all.length === 0) {
    sub.textContent = '';
    root.innerHTML = '<div class="empty">还没有 trace 数据。跑几轮对话后刷新本页。</div>';
    return;
  }
  // 日期筛选
  var turns = currentDate === 'all'
    ? all
    : all.filter(function (t) { return fmtDate(t.startedAt) === currentDate; });
  if (turns.length === 0) {
    sub.textContent = '该日期没有对话';
    root.innerHTML = '<div class="empty">该日期没有 trace 数据。换个日期或选「全部日期」。</div>';
    return;
  }

  // 按 sessionId 分组
  var order = [], groups = {};
  turns.forEach(function (t) {
    if (!groups[t.sessionId]) { groups[t.sessionId] = []; order.push(t.sessionId); }
    groups[t.sessionId].push(t);
  });
  // 最新对话在最上面：session 按其最新一轮时间降序；session 内 turn 也按时间降序
  function latest(sid) { return groups[sid].reduce(function (m, t) { return Math.max(m, t.startedAt); }, 0); }
  order.sort(function (a, b) { return latest(b) - latest(a); });
  order.forEach(function (sid) { groups[sid].sort(function (x, y) { return y.startedAt - x.startedAt; }); });

  sub.textContent = turns.length + ' 轮对话 · ' + order.length + ' 个 session';

  var html = order.map(function (sid) {
    var ts = groups[sid];
    var first = ts[0];
    var llmCalls = 0, toolCalls = 0, comp = 0, errs = 0;
    ts.forEach(function (t) {
      llmCalls += t.steps.length;
      t.steps.forEach(function (s) { toolCalls += s.toolCalls.length; });
      comp += (t.tokens && t.tokens.completion) || 0;
      if (t.status === 'error') errs++;
    });

    var turnsHtml = ts.map(function (t, ti) {
      // 串行时间线：LLM 与工具按执行顺序累加起始偏移，还原成 waterfall。
      // （query 主循环是 LLM→逐个工具→下一次 LLM 的严格串行，故累加即真实时间轴。）
      var cursor = 0;
      t.steps.forEach(function (s) {
        s._llmStart = cursor;
        cursor += s.llm.durationMs;
        s.toolCalls.forEach(function (tc) {
          tc._start = cursor;
          cursor += tc.durationMs;
        });
      });
      var total = cursor || 1;

      function seg(startMs, durMs, cls, title) {
        return '<div class="seg ' + cls + '" title="' + title + '" style="left:'
          + (startMs / total * 100) + '%;width:'
          + Math.max(0.4, durMs / total * 100) + '%"></div>';
      }

      var stepsHtml = t.steps.map(function (s) {
        var think = s.llm.finishReason === 'tool_calls';
        var contentHtml = s.llm.content
          ? '<div class="content' + (think ? ' think' : '') + '">' + esc(s.llm.content) + '</div>'
          : '';
        var toks = s.llm.tokens
          ? '<span class="tok">prompt ' + s.llm.tokens.prompt + ' · completion ' + s.llm.tokens.completion + '</span>'
          : '<span class="tok">无 usage</span>';

        var toolsHtml = s.toolCalls.map(function (tc) {
          // 单个工具在全局时间轴上的位置
          var toolTrack = '<div class="track">'
            + seg(tc._start, tc.durationMs, 'tool', tc.name + ' ' + tc.durationMs + 'ms')
            + '</div>';
          return '<details class="tool' + (tc.isError ? ' err' : '') + '">'
            + '<summary class="tool-head">'
              + '<span class="chev">▶</span>'
              + '<span class="tool-name">' + esc(tc.name) + '</span>'
              + toolTrack
              + '<span class="count">' + fmtBytes(tc.resultBytes) + '</span>'
              + '<span class="ms">' + tc.durationMs + 'ms</span>'
              + (tc.isError ? '<span class="badge error">error</span>' : '')
            + '</summary>'
            + '<div class="tool-body">'
              + '<details class="sub" open><summary><span class="chev">▶</span><span class="label">arguments</span></summary>'
                + '<pre class="args">' + esc(fmtArgs(tc.arguments)) + '</pre></details>'
              + '<details class="sub" open><summary><span class="chev">▶</span><span class="label">result · ' + tc.resultBytes + ' bytes</span></summary>'
                + '<pre>' + esc(tc.resultPreview) + '</pre></details>'
            + '</div>'
          + '</details>';
        }).join('');

        // 本步实际发出的历史消息（不含 system）
        var reqHtml = (s.request && s.request.length)
          ? '<details class="sub"><summary><span class="chev">▶</span><span class="label">请求消息 (' + s.request.length + ' 条，不含 system)</span></summary>'
            + s.request.map(function (m) {
                var tcNames = (m.toolCalls && m.toolCalls.length)
                  ? ' <span class="fr">→ ' + m.toolCalls.map(function (c) { return esc(c.name); }).join(', ') + '</span>'
                  : '';
                var bodyText = m.content
                  ? esc(m.content)
                  : (m.toolCalls ? esc(m.toolCalls.map(function (c) { return c.name + '(' + c.args + ')'; }).join(', ')) : '');
                return '<div style="margin:6px 0;border-left:2px solid var(--border);padding-left:8px">'
                  + '<b style="color:var(--dim)">[' + esc(m.role) + ']</b>' + tcNames
                  + (bodyText ? '<pre>' + bodyText + '</pre>' : '')
                + '</div>';
              }).join('')
            + '</details>'
          : '';

        var toolCount = s.toolCalls.length
          ? '<span class="count">' + s.toolCalls.length + ' tool' + (s.toolCalls.length > 1 ? 's' : '') + '</span>'
          : '';

        // 步骤轨道：本步的 LLM 段 + 它触发的工具段，都落在全局时间轴上 → 阶梯即串行
        var stepTrack = '<div class="track">'
          + seg(s._llmStart, s.llm.durationMs, 'llm', 'LLM #' + s.stepIndex + ' ' + s.llm.durationMs + 'ms')
          + s.toolCalls.map(function (tc) {
              return seg(tc._start, tc.durationMs, 'tool', tc.name + ' ' + tc.durationMs + 'ms');
            }).join('')
          + '</div>';

        return '<details class="step">'
          + '<summary class="step-head">'
            + '<span class="chev">▶</span>'
            + '<span class="step-title">LLM #' + s.stepIndex + ' <span class="fr">' + s.llm.finishReason + '</span></span>'
            + stepTrack
            + toolCount
            + '<span class="ms">' + s.llm.durationMs + 'ms</span>' + toks
          + '</summary>'
          + '<div class="step-body">'
            + reqHtml
            + (contentHtml ? '<div class="label">' + (think ? 'thinking / narration' : 'answer') + '</div>' + contentHtml : '')
            + toolsHtml
          + '</div>'
        + '</details>';
      }).join('');

      var errLine = t.status === 'error' && t.errorMessage
        ? '<div class="content" style="color:var(--red)">' + esc(t.errorMessage) + '</div>' : '';

      var legend = '<div class="legend">'
        + '<span class="lg lg-llm">LLM</span>'
        + '<span class="lg lg-tool">工具</span>'
        + '<span class="axis">时间线 · 串行 · 总 ' + total + 'ms</span>'
      + '</div>';

      // 本轮的 system 提示词（含 CLAUDE.md）与工具列表
      var sysHtml = t.systemPrompt
        ? '<details class="sub"><summary><span class="chev">▶</span><span class="label">System 提示词 (' + t.systemPrompt.length + ' chars，含 CLAUDE.md)</span></summary><pre>' + esc(t.systemPrompt) + '</pre></details>'
        : '';
      var toolsLine = (t.toolNames && t.toolNames.length)
        ? '<details class="sub"><summary><span class="chev">▶</span><span class="label">工具 (' + t.toolNames.length + ')</span></summary><pre>' + esc(t.toolNames.join(', ')) + '</pre></details>'
        : '';

      return '<details class="turn">'
        + '<summary>'
          + '<span class="chev">▶</span>'
          + '<span class="uin">' + esc(t.userInput) + '</span>'
          + '<span class="count">' + t.steps.length + ' LLM</span>'
          + '<span class="badge ' + t.status + '">' + t.status + '</span>'
          + '<span class="ms">' + t.durationMs + 'ms</span>'
          + '<span class="tok">↑' + t.tokens.promptLast + ' ↓' + t.tokens.completion + '</span>'
        + '</summary>'
        + '<div class="tbody">' + legend + sysHtml + toolsLine + errLine + stepsHtml + '</div>'
      + '</details>';
    }).join('');

    return '<details class="session">'
      + '<summary>'
        + '<span class="chev">▶</span>'
        + '<span class="sid">' + esc(sid) + '</span>'
        + '<span class="model">' + esc(first.model) + '</span>'
        + '<span class="stat"><b>' + ts.length + '</b> turns</span>'
        + '<span class="stat"><b>' + llmCalls + '</b> LLM calls</span>'
        + '<span class="stat"><b>' + toolCalls + '</b> tool calls</span>'
        + '<span class="stat">↓<b>' + comp + '</b> completion tok</span>'
        + (errs ? '<span class="stat" style="color:var(--red)"><b>' + errs + '</b> errors</span>' : '')
      + '</summary>'
      + '<div class="sbody">' + turnsHtml + '</div>'
    + '</details>';
  }).join('');

  root.innerHTML = html;
  } // end render()

  function setAll(open) {
    var all = root.querySelectorAll('details');
    for (var i = 0; i < all.length; i++) all[i].open = open;
  }

  // 日期下拉：从所有轮取去重日期，最新在前
  function buildDateOptions() {
    var all = window.__MCC_TRACE__;
    if (!Array.isArray(all)) return;
    var seen = {}, dates = [];
    all.forEach(function (t) { var d = fmtDate(t.startedAt); if (!seen[d]) { seen[d] = 1; dates.push(d); } });
    dates.sort().reverse();
    document.getElementById('dateFilter').innerHTML = '<option value="all">全部日期</option>'
      + dates.map(function (d) { return '<option value="' + d + '">' + d + '</option>'; }).join('');
  }

  buildDateOptions();
  render();
  if (Array.isArray(window.__MCC_TRACE__) && window.__MCC_TRACE__.length) toolbar.style.display = 'flex';

  document.getElementById('dateFilter').addEventListener('change', function (e) {
    currentDate = e.target.value;
    render();
  });
  document.getElementById('expandAll').addEventListener('click', function () { setAll(true); });
  document.getElementById('collapseAll').addEventListener('click', function () { setAll(false); });
})();
</script>
</body>
</html>
`
