// cli-bridge-indicator — browser half (home-level plugin). 一盏灯聚合三个 CLI：AGY / CB / MIMO。
//
// 合并 agy-indicator / codebuddy-indicator / mimo-indicator 三个家级客户端为单文件：
//   每 1.2s 轮询 GET /cli-bridge/status → { providers:{ agy,codebuddy,mimo } }，
//   每个 provider 各画一组 pill（有活动=全局显示；空转「就绪」灯=仅本会话该 preset 时显示）。
//   settings.section 一个分区「CLI Bridge」，按 provider 卡片渲染偏好（字段由后端 meta 驱动，
//   本文件不硬编码任何 provider 专有字段 —— provider 侧改设置项无需动这层）。
//
// running→蓝呼吸 ⟳  ok→绿 ✓  failed→红 ✗  fallback→琥珀 ↩  idle→灰 标签。
//
// ⚠⚠⚠ 红线 4（历史事故：agy v1.6.1 / codebuddy v1.1.8）：下方 __ModuleLoader__.load({ id })
//   必须【逐字等于 npm 包名】"@luchenglong/cli-bridge"（scoped 包=含 @scope/ 的完整名）。
//   client-modules 的 graph row 以 package name 为 id（exports["./client"] 归属包），bundle
//   脚本执行后按 loaded without registering "<packageName>" 校验；一旦不等 → 整个 client
//   combo 加载失败 → DSH 启动致命屏 → 强制安全模式。slot id 与 CSS 标记是另一命名空间，可自取。
//   改包名 = 必改此 id，二者绑定，永远一起改。

window.__ModuleLoader__.load({
  id: "@luchenglong/cli-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    // provider 展示元数据（与后端 registry 对齐；渲染顺序）。
    // ⚠ 仅作 fallback：新 CLI 接入时后端视图（providers 键 + scheduling.all/labels）是
    // 权威轴，本表不更新也只丢 presetId 的「就绪灯」优化，卡片/标签页/调度自动跟上。
    var PROVIDERS = [
      { id: "agy", label: "AGY", presetId: "cordis-agy" },
      { id: "codebuddy", label: "CB", presetId: "codebuddy-first" },
      { id: "mimo", label: "MIMO", presetId: "cordis-mimo" }
    ];
    const PRESET_ID_OF = {};
    for (const m of PROVIDERS) PRESET_ID_OF[m.id] = m.presetId;
    const FALLBACK_LABEL = {};
    for (const m of PROVIDERS) FALLBACK_LABEL[m.id] = m.label;

    // 后端驱动 id 轴：从调度视图（scheduling.all + labels）或 status 视图取全量 id，
    // 本地 PROVIDERS 仅补 presetId（就绪灯判定用）。新增 provider = 后端 registry 一行，
    // 本文件零改动。
    function providerMetas(sc, extra) {
      const ids = (sc && Array.isArray(sc.all)) ? sc.all.slice()
        : (extra && Array.isArray(extra.all) ? extra.all.slice()
          : PROVIDERS.map(function (m) { return m.id; }));
      const labels = (sc && sc.labels) || (extra && extra.labels) || {};
      const out = [];
      for (const id of ids) {
        out.push({ id: id, label: labels[id] || FALLBACK_LABEL[id] || String(id).toUpperCase(), presetId: PRESET_ID_OF[id] || null });
      }
      return out;
    }


    const CSS = [
      ".clb-row{display:inline-flex;align-items:center;gap:6px}",
      ".clb-ind{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap;user-select:none}",
      ".clb-ind:hover{border-color:var(--dsw-alias-border-l2);cursor:pointer}",
      ".clb-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-secondary)}",
      ".clb-ind b{font-weight:600}",
      ".clb-run .clb-dot{background:var(--dsw-static-blue-500,#3b82f6);animation:clb-pulse 1s ease-in-out infinite}",
      ".clb-ok .clb-dot{background:var(--dsw-static-green-500,#22c55e)}",
      ".clb-fail .clb-dot{background:var(--dsw-alias-state-error-primary)}",
      ".clb-fb .clb-dot{background:var(--dsw-alias-state-warn-primary)}",
      ".clb-run{color:var(--dsw-static-blue-500,#3b82f6);border-color:var(--dsw-static-blue-500,#3b82f6)}",
      ".clb-ok{color:var(--dsw-static-green-500,#22c55e);border-color:var(--dsw-static-green-500,#22c55e)}",
      ".clb-fb{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
      "@keyframes clb-pulse{0%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}100%{opacity:1;transform:scale(1)}}",
      ".clb-pop-overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:10000;display:flex;align-items:center;justify-content:center}",
      ".clb-pop-panel{width:560px;max-width:92vw;max-height:76vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:hidden}",
      ".clb-pop-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600}",
      ".clb-pop-close{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:22px;height:22px;line-height:1;font-size:13px;cursor:pointer}",
      ".clb-pop-close:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
      ".clb-pop-body{overflow:auto;padding:12px 14px}",
      ".clb-pop-sec{margin-bottom:14px;padding-bottom:12px;border-bottom:1px dashed var(--dsw-alias-border-l1)}",
      ".clb-pop-sec:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}",
      ".clb-pop-sech{font-weight:600;margin-bottom:6px}",
      ".clb-pop-proj{margin:6px 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}",
      ".clb-pop-proj-head{font-weight:600;margin-bottom:4px}",
      ".clb-pop-mono{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".clb-pop-line{padding:1px 0}",
      ".clb-pop-cur{background:rgba(59,130,246,.12);border-radius:4px;padding:3px 6px;margin:4px 0}",
      ".clb-pop-empty{color:var(--dsw-alias-label-secondary);padding:4px 0}",
      // ── 设置面板 ──────────────────────────────────────────────────────────
      ".clbs-root{display:flex;flex-direction:column;gap:16px;max-width:720px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}",
      ".clbs-h{font-size:14px;font-weight:600}",
      ".clbs-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}",
      ".clbs-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 14px}",
      ".clbs-card-h{font-weight:600;font-size:13px;margin-bottom:10px}",
      ".clbs-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:10px}",
      ".clbs-tab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 12px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;font-family:inherit}",
      ".clbs-tab:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
      ".clbs-tab-on{background:var(--dsw-static-blue-500,#3b82f6);border-color:var(--dsw-static-blue-500,#3b82f6);color:#fff;font-weight:600}",
      ".clbs-tab-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-static-green-500,#22c55e);flex:none}",
      ".clbs-tab-dot-off{background:var(--dsw-alias-label-tertiary,var(--dsw-alias-border-l2))}",
      ".clbs-tab-rank{font-size:10px;opacity:.8}",

      ".clbs-card-off{opacity:.62}",
      ".clbs-card-hrow{display:flex;align-items:center;gap:8px;margin-bottom:10px}",
      ".clbs-card-t{font-weight:600;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".clbs-chip{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:9px;font-size:11px;font-weight:600;white-space:nowrap}",
      ".clbs-chip-on{background:rgba(34,197,94,.14);color:var(--dsw-static-green-500,#22c55e)}",
      ".clbs-chip-off{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
      ".clbs-chip-rank{background:var(--dsw-static-blue-500,#3b82f6);color:#fff}",
      ".clbs-grid{display:grid;grid-template-columns:130px 1fr;gap:8px 12px;align-items:center}",
      ".clbs-label{color:var(--dsw-alias-label-secondary);text-align:right;font-size:12px}",
      ".clbs-ctl{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".clbs-note{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px}",
      ".clbs-input,.clbs-select{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-input,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;outline:none}",
      ".clbs-input:focus,.clbs-select:focus{border-color:var(--dsw-alias-border-brand,var(--dsw-static-blue-500,#3b82f6))}",
      ".clbs-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}",
      ".clbs-actions{display:flex;align-items:center;gap:10px}",
      ".clbs-btn{height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-brand,var(--dsw-static-blue-500,#3b82f6));background:var(--dsw-static-blue-500,#3b82f6);color:#fff;font-size:12px;cursor:pointer}",
      ".clbs-btn:hover{opacity:.9}",
      ".clbs-btn:disabled{opacity:.5;cursor:default}",
      ".clbs-btn-ghost{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}",
      ".clbs-msg{font-size:12px}",
      ".clbs-msg-ok{color:var(--dsw-static-green-500,#22c55e)}",
      ".clbs-msg-err{color:var(--dsw-alias-state-error-primary)}",
      ".clbs-diag{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}",
      ".clbs-diag-h{padding:6px 10px;background:var(--dsw-alias-bg-layer-2);font-weight:600;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".clbs-diag-row{display:grid;grid-template-columns:150px 1fr auto;gap:8px;padding:7px 10px;border-bottom:1px dashed var(--dsw-alias-border-l1);align-items:center;font-size:12px}",
      ".clbs-diag-row:last-child{border-bottom:none}",
      ".clbs-diag-mono{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".clbs-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:9px;font-size:11px;white-space:nowrap}",
      ".clbs-badge-ok{color:var(--dsw-static-green-500,#22c55e);border:1px solid var(--dsw-static-green-500,#22c55e)}",
      ".clbs-badge-warn{color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary)}",
      ".clbs-badge-err{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary)}",
      ".clbs-disp-row{display:grid;grid-template-columns:auto auto 1fr auto;gap:10px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}",
      ".clbs-disp-row:last-child{border-bottom:none}",
      ".clbs-disp-name{font-weight:600;font-size:12px}",
      ".clbs-disp-off .clbs-disp-name{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-weight:400}",
      ".clbs-disp-ord{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:9px;background:var(--dsw-static-blue-500,#3b82f6);color:#fff;font-size:11px;font-weight:600}",
      ".clbs-disp-btn{width:24px;height:22px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;padding:0}",
      ".clbs-disp-btn:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".clbs-disp-btn:disabled{opacity:.3;cursor:default}"
    ].join("");
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="cli-bridge-indicator"]') === null) {
      const tag = document.createElement("style");
      tag.setAttribute("data-plugin", "cli-bridge-indicator");
      tag.setAttribute("data-plugin-css", "cli-bridge-indicator");
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function pillClass(state) {
      if (state === "running") return " clb-run";
      if (state === "ok") return " clb-ok";
      if (state === "failed") return " clb-fail";
      if (state === "fallback") return " clb-fb";
      return "";
    }
    function pillText(label, state, running) {
      if (state === "running") return "\u27F3 " + label + (running > 1 ? " \u00D7" + running : "");
      if (state === "ok") return "\u2713 " + label;
      if (state === "failed") return "\u2717 " + label;
      if (state === "fallback") return "\u21A9 " + label;
      return label;
    }
    function argText(a) {
      if (a === undefined || a === null) return "";
      try { const j = JSON.stringify(a); return j.length > 140 ? j.slice(0, 137) + "\u2026" : j; } catch (e) { return String(a); }
    }

    function Pill(props) {
      const p = props.p, label = props.label;
      const parts = [];
      parts.push("project: " + (p.name || p.cwd));
      if (p.current) { const c = p.current; parts.push("step " + c.stepIndex + " \u2192 " + c.tool + (c.args ? " " + argText(c.args) : "")); }
      else if (p.running > 0) parts.push("(starting / thinking)");
      if (p.trail && p.trail.length) parts.push("recent: " + p.trail.slice(-3).map(function (e) { return e.state + " " + e.tool; }).join(" | "));
      if (p.lastStatus) parts.push("last=" + p.lastStatus + (p.lastSessionId ? " " + String(p.lastSessionId).slice(0, 8) : ""));
      if (p.lastBackend) parts.push("backend=" + p.lastBackend);
      return react.createElement("div", { className: "clb-ind" + pillClass(p.state), title: label.toLowerCase() + " [" + p.state + (p.running > 0 ? " \u00D7" + p.running : "") + "] " + p.cwd + "\n" + parts.join("\n"), onClick: props.onClick },
        react.createElement("span", { className: "clb-dot" }),
        react.createElement("span", null, react.createElement("b", null, pillText(label, p.state, p.running))));
    }

    function ProjectRow(props) {
      const p = props.p;
      const head = (p.state === "running" ? "\u27F3 " : p.state === "ok" ? "\u2713 " : p.state === "failed" ? "\u2717 " : p.state === "fallback" ? "\u21A9 " : "") + (p.name || p.cwd);
      const badge = "[" + p.state + (p.running > 0 ? " \u00D7" + p.running : "") + "]";
      return react.createElement("div", { className: "clb-pop-proj" },
        react.createElement("div", { className: "clb-pop-proj-head" }, head, " ", react.createElement("span", { className: "clb-pop-mono" }, badge)),
        react.createElement("div", { className: "clb-pop-line clb-pop-mono" }, p.cwd),
        (function () {
          if (p.current) { const c = p.current; return react.createElement("div", { className: "clb-pop-cur" },
            react.createElement("div", null, "当前: step " + c.stepIndex + " \u2192 " + c.tool),
            react.createElement("div", { className: "clb-pop-mono" }, c.args ? argText(c.args) : "")); }
          if (p.running > 0) return react.createElement("div", { className: "clb-pop-cur" }, "(starting / thinking\u2026)");
          return null;
        })(),
        (p.trail && p.trail.length) ? react.createElement("div", null,
          react.createElement("div", { className: "clb-pop-line", style: { marginTop: "6px", color: "var(--dsw-alias-label-secondary)" } }, "最近步骤:"),
          p.trail.slice(-6).map(function (e, j) {
            return react.createElement("div", { key: "t" + j, className: "clb-pop-line clb-pop-mono" },
              "[" + e.state + "] step " + e.stepIndex + " " + e.tool + (e.args ? " " + argText(e.args) : ""));
          })) : null,
        (p.running > 0 && p.updatedAt) ? react.createElement("div", { className: "clb-pop-line", style: { marginTop: "6px", color: (Date.now() - p.updatedAt > 90000 ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)") } },
          "无活动 " + Math.max(0, Math.round((Date.now() - p.updatedAt) / 1000)) + "s" + (Date.now() - p.updatedAt > 90000 ? "（长任务请耐心；疑似卡住可取消重试）" : "")) : null,
        (p.lastStatus) ? react.createElement("div", { className: "clb-pop-line clb-pop-mono", style: { marginTop: "6px" } },
          "last=" + p.lastStatus + (p.lastSessionId ? " " + String(p.lastSessionId).slice(0, 8) : "")) : null);
    }

    function Popup(props) {
      const s = props.s, onClose = props.onClose;
      const sections = [];
      const metas = providerMetas(null, (s && s.providers) ? { all: Object.keys(s.providers), labels: (s.scheduling && s.scheduling.labels) } : null);
      for (const meta of metas) {
        const b = (s && s.providers && s.providers[meta.id]) || null;
        const ready = props.iAm[meta.id];
        const hasProjects = b && Array.isArray(b.projects) && b.projects.length;
        if (!hasProjects && !(ready === true || (ready === null && b && b.presetActive))) continue;
        let rows;
        if (hasProjects) rows = b.projects.map(function (p, i) { return react.createElement(ProjectRow, { key: p.cwd || ("p" + i), p: p }); });
        else rows = react.createElement("div", { className: "clb-pop-empty" }, "（就绪，暂无活动）");
        const modeText = ready === true ? " · 本会话 " + meta.label + " 优先" : (ready === false ? " · 普通模式" : (b && b.presetActive ? " · " + meta.label + " 优先（其他会话）" : " · 普通模式"));
        sections.push(react.createElement("div", { key: meta.id, className: "clb-pop-sec" },
          react.createElement("div", { className: "clb-pop-sech" }, meta.label + " 状态" + (b && b.state ? " · " + b.state + (b.running > 0 ? " (" + b.running + " running)" : "") : "") + modeText),
          rows));
      }
      if (!sections.length) sections.push(react.createElement("div", { className: "clb-pop-empty" }, "暂无 CLI Bridge 活动"));
      return react.createElement("div", { className: "clb-pop-overlay", onClick: onClose },
        react.createElement("div", { className: "clb-pop-panel", onClick: function (e) { e.stopPropagation(); } },
          react.createElement("div", { className: "clb-pop-head" },
            react.createElement("span", null, "CLI Bridge"),
            react.createElement("button", { className: "clb-pop-close", title: "关闭 (Esc)", onClick: onClose }, "\u2715")),
          react.createElement("div", { className: "clb-pop-body" }, sections)));
    }

    // per-session preset 三态判定（同 codebuddy v1.1.3：host 名单 + 客户端摘要双通道，
    // 任一肯定即肯定；都否定才否定；无结论回退全局租约）。myPreset 是会话的单个
    // agentPreset 值，对每个 provider 比较各自的 presetId。
    const PRESET_UNKNOWN = "\u0000unknown";
    function subscribeNoop() { return function () { }; }
    function presetOfSummary(sum) {
      if (!sum) return PRESET_UNKNOWN;
      if (sum.projectionValues && typeof sum.projectionValues.agentPreset === "string") return sum.projectionValues.agentPreset;
      if (typeof sum.agentPreset === "string") return sum.agentPreset;
      return PRESET_UNKNOWN;
    }
    function presetOfState(state, sessionId) {
      try { if (!state || !sessionId || !state.byId) return PRESET_UNKNOWN; return presetOfSummary(state.byId[sessionId]); }
      catch (e) { return PRESET_UNKNOWN; }
    }

    function Indicator(props) {
      const p = props || {};
      const sessionId = (typeof p.sessionId === "string" && p.sessionId) || (typeof p.injectedSessionId === "string" && p.injectedSessionId) || undefined;
      const useSess = typeof p.useSessions === "function" ? p.useSessions : null;
      const sessionsSvc = p.sessionsSvc;
      const st = react.useState(null); const s = st[0]; const setS = st[1];
      const ot = react.useState(false); const open = ot[0]; const setOpen = ot[1];
      let myPreset;
      if (useSess) {
        myPreset = useSess(function (state) { return presetOfState(state, sessionId); });
      } else {
        myPreset = react.useSyncExternalStore(
          (sessionsSvc && sessionsSvc.list) ? sessionsSvc.list.subscribe : subscribeNoop,
          function () {
            try {
              if (!sessionsSvc || !sessionsSvc.list) return PRESET_UNKNOWN;
              return presetOfState(sessionsSvc.list.getSnapshot(), sessionId);
            } catch (e) { return PRESET_UNKNOWN; }
          });
      }
      const presetKnown = myPreset !== PRESET_UNKNOWN;
      const metas = providerMetas(null, (s && s.providers) ? { all: Object.keys(s.providers), labels: (s.scheduling && s.scheduling.labels) } : null);
      const iAm = {};
      for (const meta of metas) {
        const b = (s && s.providers && s.providers[meta.id]) || null;
        const hostList = (b && Array.isArray(b.presetSessions)) ? b.presetSessions : null;
        const inHostList = !!(hostList && sessionId && hostList.indexOf(sessionId) >= 0);
        const clientSaysYes = presetKnown && myPreset === meta.presetId;
        iAm[meta.id] = (inHostList || clientSaysYes)
          ? true
          : (presetKnown ? false
              : ((hostList && hostList.length > 0 && sessionId) ? false : null));
      }
      react.useEffect(function () {
        let alive = true; let timerId = null;
        const tick = function () {
          fetch("/cli-bridge/status", { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (v) { if (alive) setS(v); })
            .catch(function () { });
        };
        tick(); timerId = setInterval(tick, 1200);
        return function () { alive = false; if (timerId !== null) clearInterval(timerId); };
      }, []);
      react.useEffect(function () {
        if (!open) return;
        const h = function (e) { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", h);
        return function () { window.removeEventListener("keydown", h); };
      }, [open]);
      const pills = [];
      // 陈旧过滤（0.2.1 修复「指示灯长期存在」）：stale 项目（>10min 无活动且未运行）不再
      // 渲染成常亮灯。历史事故：一次失败后 ✗ AGY 灯永久挂在那 —— 弹窗里仍列 stale 项目作
      // 历史，但 pill 行只认新鲜活动。
      for (const meta of metas) {
        const b = (s && s.providers && s.providers[meta.id]) || null;
        if (!b) continue;
        const fresh = (Array.isArray(b.projects) ? b.projects : []).filter(function (p) { return !p.stale; });
        const readyShow = iAm[meta.id] === true || (iAm[meta.id] === null && b.presetActive);
        if (fresh.length) {
          for (let i = 0; i < fresh.length; i++) pills.push(react.createElement(Pill, { key: meta.id + ":" + (fresh[i].cwd || i), p: fresh[i], label: meta.label, onClick: function () { setOpen(true); } }));
        } else if (readyShow) {
          const state = b.state || "idle";
          let text = meta.label + " 就绪";
          if (state === "running") text = meta.label + " 工作中" + (b.running > 1 ? " \u00D7" + b.running : "");
          else if (state === "ok") text = meta.label;
          else if (state === "failed") text = meta.label + " 失败";
          else if (state === "fallback") text = "本地回退";
          pills.push(react.createElement("div", { key: meta.id + ":ready", className: "clb-ind" + pillClass(state), title: meta.id + " state=" + state + " running=" + (b.running || 0), onClick: function () { setOpen(true); } },
            react.createElement("span", { className: "clb-dot" }), react.createElement("span", null, text)));
        }
      }
      if (!pills.length) return null;
      const light = react.createElement("div", { className: "clb-row" }, pills);
      if (!open) return light;
      return react.createElement(react.Fragment, null, light,
        react.createElement(Popup, { s: s, iAm: iAm, onClose: function () { setOpen(false); } }));
    }

    // ── 设置面板（settings.section）：字段由后端 providers[id].meta.fields 驱动 ──
    function Field(props) {
      const f = props.field, val = props.value, onChange = props.onChange, secretState = props.secret;
      if (f.type === "select") {
        const opts = Array.isArray(f.options) ? f.options : [];
        const isKnown = opts.some(function (o) { return String(o.value) === String(val); });
        const CUSTOM = "__clb_custom__";
        // wantCustom：用户显式选了「自定义…」后保持输入框可见（即使此刻值为空）。
        const wc = react.useState(false); const wantCustom = wc[0]; const setWantCustom = wc[1];
        const showCustom = f.allowCustom && (wantCustom || (val !== "" && !isKnown));
        const sel = showCustom && (wantCustom || !isKnown) && val !== "" ? val : (val === "" && wantCustom ? CUSTOM : val);
        const onPick = function (e) {
          const v = e.target.value;
          if (v === CUSTOM) { setWantCustom(true); onChange(""); return; }
          setWantCustom(false); onChange(v);
        };
        return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
          react.createElement("select", { className: "clbs-select", value: sel, onChange: onPick },
            react.createElement("option", { key: "__empty", value: "" }, f.placeholder || "（留空 = 默认）"),
            opts.map(function (o) { return react.createElement("option", { key: o.value, value: o.value }, o.label || o.value); }),
            f.allowCustom ? react.createElement("option", { key: "__custom", value: CUSTOM }, "自定义…（手动输入）") : null),
          showCustom ? react.createElement("input", { className: "clbs-input", value: val, onChange: function (e) { onChange(e.target.value); }, placeholder: "手动输入值", spellCheck: false }) : null,
          f.note ? react.createElement("div", { className: "clbs-note" }, f.note) : null);
      }
      if (f.secret) {
        return react.createElement("div", { className: "clbs-ctl" },
          react.createElement("input", { className: "clbs-input", type: "password", value: val, onChange: function (e) { onChange(e.target.value); }, placeholder: secretState && secretState.set ? ("已保存 " + secretState.hint + "，留空保持不变") : (f.placeholder || "留空保持不变"), spellCheck: false, autoComplete: "off" }),
          react.createElement("label", { className: "clbs-check" },
            react.createElement("input", { type: "checkbox", checked: !!props.wantClear, onChange: function (e) { props.onClear(e.target.checked); } }),
            "清除已保存的值"),
          f.note ? react.createElement("div", { className: "clbs-note" }, f.note) : null);
      }
      return react.createElement("div", { className: "clbs-ctl" },
        react.createElement("input", { className: "clbs-input", value: val, onChange: function (e) { onChange(e.target.value); }, placeholder: f.placeholder || "", spellCheck: false }),
        f.note ? react.createElement("div", { className: "clbs-note" }, f.note) : null);
    }

    // ── 调度卡（0.2.0）：勾选启用哪些 CLI + 上下移排定调用优先级（顺序=优先级）──
    // ord 数组 = 全量 id 的展示/排序顺序；enabled = 启用的 id 集合。未启用者沉到列表
    // 底部但仍可 ↑↓（改的是 priority，不代表顺序变了就自动启用）。优先级只对启用项有意义，
    // 后端 order 派生自 priority ∩ enabled，UI 这里把 disabled 项以灰显示但保留其 priority 位。
    function DispatchCard(props) {
      const ord = props.ord, enabled = props.enabled, labels = props.labels;
      const toggle = props.onToggle, move = props.onMove;
      const supported = props.supported !== false;
      const anyEnabled = enabled.length > 0;
      const zh = (function () { try { return String(navigator.language || "").toLowerCase().indexOf("zh") === 0; } catch (e) { return false; } })();
      const rankOf = {};
      // 展示序 = ord 全量；序号徽标只对启用项计数。
      let n = 0;
      for (const id of ord) { if (enabled.indexOf(id) >= 0) { rankOf[id] = (++n); } }
      return react.createElement("div", { className: "clbs-card" },
        react.createElement("div", { className: "clbs-card-h" }, zh ? "调度 · 启用与优先级" : "Dispatch · enable & priority"),
        react.createElement("div", { className: "clbs-sub", style: { margin: "-4px 0 8px" } },
          zh ? "勾选要启用的 CLI（决定调用面数量），↑↓ 排定智能体的调用优先级（首位最高）。保存后 preset / 动态 / MCP 三形态生效（MCP 需重启子进程）。"
             : "Check which CLIs to enable, use ↑↓ to set call priority (top = highest)."),
        supported ? null
          : react.createElement("div", { className: "clbs-msg clbs-msg-err", style: { marginBottom: "8px" } },
              zh ? "当前运行的宿主尚不支持调度（本面板为新版本）：请重启 DSH 后重新打开设置再修改启用/优先级。"
                 : "The running host does not support scheduling yet; restart DSH before changing this card."),
        ord.map(function (id, idx) {
          const on = enabled.indexOf(id) >= 0;
          return react.createElement("div", { key: id, className: "clbs-disp-row" + (on ? "" : " clbs-disp-off") },
            react.createElement("label", { className: "clbs-check" },
              react.createElement("input", { type: "checkbox", checked: on, disabled: !supported, onChange: function () { toggle(id); } })),
            react.createElement("span", null,
              on ? react.createElement("span", { className: "clbs-disp-ord" }, String(rankOf[id])) : react.createElement("span", { className: "clbs-disp-ord", style: { background: "transparent", color: "var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))", border: "1px dashed var(--dsw-alias-border-l1)" }, title: zh ? "未启用" : "disabled" }, "—"),
              react.createElement("span", { className: "clbs-disp-name", style: { marginLeft: "8px" } }, (labels && labels[id]) || id)),
            react.createElement("span", null),
            react.createElement("span", { style: { display: "inline-flex", gap: "4px" } },
              react.createElement("button", { className: "clbs-disp-btn", type: "button", disabled: idx === 0 || !supported, onClick: function () { move(idx, -1); }, title: zh ? "上移（提高优先级）" : "up" }, "\u2191"),
              react.createElement("button", { className: "clbs-disp-btn", type: "button", disabled: idx === ord.length - 1 || !supported, onClick: function () { move(idx, 1); }, title: zh ? "下移（降低优先级）" : "down" }, "\u2193")));
        }),
        !anyEnabled ? react.createElement("div", { className: "clbs-msg clbs-msg-err", style: { marginTop: "8px" } },
          zh ? "⚠ 全部禁用：三形态都不会注册任何 CLI 工具。" : "All disabled: no CLI tools will be registered.") : null);
    }

    function ProviderSettingsCard(props) {
      const meta = props.meta, view = props.view, form = props.form, setField = props.setField, clears = props.clears, setClear = props.setClear;
      if (!view || !view.present) return null;
      const fields = (view.meta && Array.isArray(view.meta.fields)) ? view.meta.fields : [];
      // 卡片头状态条：调度启用/禁用 + 优先级名次（来自调度视图，与调度卡同源，两处永远一致）。
      const chip = props.on ? react.createElement("span", { className: "clbs-chip clbs-chip-on" }, props.zh ? "启用" : "on")
        : react.createElement("span", { className: "clbs-chip clbs-chip-off" }, props.zh ? "未启用" : "off");
      const rank = props.on && props.rank ? react.createElement("span", { className: "clbs-chip clbs-chip-rank", title: props.zh ? "调用优先级" : "call priority" }, "#" + props.rank) : null;
      return react.createElement("div", { className: "clbs-card" + (props.on ? "" : " clbs-card-off") },
        react.createElement("div", { className: "clbs-card-hrow" },
          react.createElement("span", { className: "clbs-card-t" }, meta.label + (view.meta && view.meta.titleSuffix ? " · " + view.meta.titleSuffix : "")),
          rank, chip),
        fields.length ? react.createElement("div", { className: "clbs-grid" },
          fields.map(function (f) {
            return react.createElement(react.Fragment, { key: f.key },
              react.createElement("label", { className: "clbs-label" }, f.label || f.key),
              react.createElement(Field, {
                field: f, value: form[f.key] || "", secret: view.secrets && view.secrets[f.key], wantClear: !!(clears[meta.id] && clears[meta.id][f.key]),
                onChange: function (v) { setField(meta.id, f.key, v); }, onClear: function (b) { setClear(meta.id, f.key, b); }
              }));
          })) : react.createElement("div", { className: "clbs-note" }, "（无可配置项）"),
        (!props.on) ? react.createElement("div", { className: "clbs-note", style: { marginTop: "8px" } },
          props.zh ? "此 CLI 已在「调度」卡停用：三形态不会注册它的工具/政策段。下方偏好仍会保存并在重新启用后生效。"
                   : "Disabled in the dispatch card: no tools/policy will register. Preferences below are still saved.") : null,
        (view.diagnosis) ? react.createElement("div", { className: "clbs-diag" },
          react.createElement("div", { className: "clbs-diag-h" }, "诊断"),
          react.createElement("div", { style: { padding: "7px 10px", fontSize: "12px" } }, view.diagnosis)) : null);
    }

    function SettingsPanel() {
      const vt = react.useState(null); const view = vt[0]; const setView = vt[1];
      const ft = react.useState({}); const form = ft[0]; const setForm = ft[1];
      const ct = react.useState({}); const clears = ct[0]; const setClears = ct[1];
      const mt = react.useState(null); const msg = mt[0]; const setMsg = mt[1];
      const lt = react.useState(false); const loading = lt[0]; const setLoading = lt[1];
      // 调度状态：disp.ord = 全量 id 的排序顺序（= priority），disp.enabled = 启用集合。
      const dt = react.useState({ ord: [], enabled: [] }); const disp = dt[0]; const setDisp = dt[1];
      // 标签页选择（0.2.2 横向卡片）：必须在早期 return 之前声明（React hook 顺序恒定）。
      const tt = react.useState("global"); const tab = tt[0]; const setTab = tt[1];

      const adopt = react.useCallback(function (v) {
        setView(v);
        const next = {};
        // 后端驱动：以视图 providers 键为轴（新增 provider 零改动），本地表仅兜底。
        const viewIds = (v && v.providers) ? Object.keys(v.providers) : PROVIDERS.map(function (m) { return m.id; });
        for (const meta of providerMetas(v && v.scheduling, { all: viewIds })) {
          const pv = (v && v.providers && v.providers[meta.id]) || {};
          next[meta.id] = Object.assign({}, pv.values || {});
          const secs = pv.secrets || {};
          for (const k of Object.keys(secs)) next[meta.id][k] = "";
        }
        setForm(next);
        // 调度视图：后端 scheduling.priority = 全量 id 的完整顺序（未启用的也在其中，
        // 保留其位置，灰显可移动）；scheduling.enabled = 启用集合。启用项的序号徽标
        // = 它们在 priority 里的相对次序（后端 order 同派生规则，UI 与生效面一致）。
        const sc = (v && v.scheduling) || {};
        const all = Array.isArray(sc.all) ? sc.all : PROVIDERS.map(function (m) { return m.id; });
        const en = Array.isArray(sc.enabled) ? sc.enabled.filter(function (x) { return all.indexOf(x) >= 0; }) : all.slice();
        const srcOrd = Array.isArray(sc.priority) && sc.priority.length ? sc.priority : (Array.isArray(sc.order) ? sc.order : en);
        const ord = srcOrd.filter(function (x) { return all.indexOf(x) >= 0; });
        for (const id of all) if (ord.indexOf(id) < 0) ord.push(id);
        setDisp({ ord: ord, enabled: en });
      }, []);
      const reload = react.useCallback(function () {
        fetch("/cli-bridge/settings", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
          .then(adopt)
          .catch(function (e) { setMsg({ kind: "err", text: "读取失败：" + e.message }); });
      }, [adopt]);
      react.useEffect(function () { reload(); }, [reload]);

      const setField = function (id, k, v) { setForm(function (f) { const n = Object.assign({}, f); n[id] = Object.assign({}, n[id]); n[id][k] = v; return n; }); };
      const setClear = function (id, k, b) { setClears(function (c) { const n = Object.assign({}, c); n[id] = Object.assign({}, n[id]); n[id][k] = b; return n; }); };

      const dispToggle = function (id) {
        setDisp(function (d) {
          const en = d.enabled.indexOf(id) >= 0 ? d.enabled.filter(function (x) { return x !== id; }) : d.enabled.concat([id]);
          return { ord: d.ord, enabled: en };
        });
      };
      const dispMove = function (idx, delta) {
        setDisp(function (d) {
          const j = idx + delta;
          if (idx < 0 || j < 0 || idx >= d.ord.length || j >= d.ord.length) return d;
          const ord = d.ord.slice();
          const tmp = ord[idx]; ord[idx] = ord[j]; ord[j] = tmp;
          return { ord: ord, enabled: d.enabled };
        });
      };
      const dispLabels = (view && view.scheduling && view.scheduling.labels) || {};

      const save = function () {
        if (!view || loading) return;
        setLoading(true); setMsg(null);
        const body = {};
        for (const meta of providerMetas(view.scheduling, { all: view.providers ? Object.keys(view.providers) : null })) {
          const pv = (view.providers && view.providers[meta.id]) || {};
          if (!pv.present) continue;
          const fields = (pv.meta && Array.isArray(pv.meta.fields)) ? pv.meta.fields : [];
          const part = {};
          for (const f of fields) {
            const v = (form[meta.id] && form[meta.id][f.key]) || "";
            if (f.secret) {
              if (v) part[f.key] = v;
              else if (clears[meta.id] && clears[meta.id][f.key]) part[f.key + "Clear"] = true;
            } else part[f.key] = v;
          }
          body[meta.id] = part;
        }
        // 调度区：enabled = 启用集合，priority = ord 全量顺序（后端 order 派生 ∩ enabled）。
        // 旧宿主（无 scheduling 视图）会静默丢弃 _scheduling —— 运行中面板与新 client 存在
        // 过渡窗口，此时跳过调度字段并在保存后明确提示，避免「假成功」。
        const schedSupported = !!(view && view.scheduling);
        if (schedSupported) body._scheduling = { enabled: disp.enabled.slice(), priority: disp.ord.slice() };
        fetch("/cli-bridge/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
          .then(function (res) {
            setLoading(false);
            if (res.code === 200 && res.j && res.j.ok) {
              setClears({}); if (res.j.settings) adopt(res.j.settings);
              setMsg({ kind: schedSupported ? "ok" : "err", text: schedSupported
                ? "已保存 ✓ 调度 / 偏好即时生效（preset、动态形态下次会话装配即读；MCP 子进程需重启才刷新工具面）"
                : "已保存（provider 偏好）；宿主不支持调度字段，重启 DSH 后在面板重新保存启用/优先级。" });
            } else setMsg({ kind: "err", text: "保存失败：" + ((res.j && res.j.error) || ("HTTP " + res.code)) });
          })
          .catch(function (e) { setLoading(false); setMsg({ kind: "err", text: "保存失败：" + e.message }); });
      };

      if (!view) {
        return react.createElement("div", { className: "clbs-root" },
          react.createElement("div", { className: "clbs-h" }, "CLI Bridge"),
          react.createElement("div", { className: "clbs-sub" }, msg ? msg.text : "加载设置…"));
      }
      const zh = (function () { try { return String(navigator.language || "").toLowerCase().indexOf("zh") === 0; } catch (e) { return false; } })();
      // 名次表：启用项在 ord 中的相对次序 = 后端 order（priority ∩ enabled）同源派生。
      const rankOf = {};
      (function () { let n = 0; for (const id of disp.ord) { if (disp.enabled.indexOf(id) >= 0) rankOf[id] = (++n); } })();
      // id 轴 = 后端视图（scheduling.all ∪ providers 键），本地表只补 presetId。
      const orderedMeta = (function () {
        const byId = {};
        for (const m of providerMetas(view.scheduling, { all: view.providers ? Object.keys(view.providers) : null })) byId[m.id] = m;
        const ordered = disp.ord.map(function (id) { return byId[id]; }).filter(Boolean);
        for (const id in byId) if (!ordered.some(function (m) { return m.id === id; })) ordered.push(byId[id]);
        return ordered;
      })();
      // 横向标签页模式（0.2.2）：一排名字点击切换，页面永远只有一屏高度；
      // 未来加第 4、5 个 CLI 只是多一个 tab（tabs 容器 flex-wrap 自动换行），
      // 不再纵向堆叠。首排「总设置」= 调度（启用数量 + 优先级），其余 = 各 CLI 偏好。
      const tabs = [react.createElement("button", {
        key: "global", type: "button", className: "clbs-tab" + (tab === "global" ? " clbs-tab-on" : ""),
        onClick: function () { setTab("global"); }
      }, zh ? "总设置" : "Global")];
      for (const meta of orderedMeta) {
        const on = disp.enabled.indexOf(meta.id) >= 0;
        const hasView = !!(view.providers && view.providers[meta.id] && view.providers[meta.id].present);
        if (!hasView) continue;
        tabs.push(react.createElement("button", {
          key: meta.id, type: "button", className: "clbs-tab" + (tab === meta.id ? " clbs-tab-on" : ""),
          title: (on ? (zh ? "已启用" : "enabled") : zh ? "未启用" : "disabled") + (on && rankOf[meta.id] ? " · " + (zh ? "优先级" : "priority") + " #" + rankOf[meta.id] : ""),
          onClick: function () { setTab(meta.id); }
        },
          react.createElement("span", { className: "clbs-tab-dot" + (on ? "" : " clbs-tab-dot-off") }),
          (dispLabels && dispLabels[meta.id]) || meta.label,
          on && rankOf[meta.id] ? react.createElement("span", { className: "clbs-tab-rank" }, "#" + rankOf[meta.id]) : null));
      }
      const activeMeta = (function () { for (const m of orderedMeta) if (m.id === tab) return m; return null; })();
      const activeOn = tab !== "global" && disp.enabled.indexOf(tab) >= 0;
      return react.createElement("div", { className: "clbs-root" },
        react.createElement("div", null,
          react.createElement("div", { className: "clbs-h" }, "CLI Bridge"),
          react.createElement("div", { className: "clbs-sub" }, "AGY / CodeBuddy / MiMo 三条 CLI 桥接的派发偏好。保存后对各自的 preset、动态插件与 MCP 三种形态即时生效。")),
        react.createElement("div", { className: "clbs-tabs" }, tabs),
        tab === "global"
          ? react.createElement(DispatchCard, { ord: disp.ord, enabled: disp.enabled, labels: dispLabels, onToggle: dispToggle, onMove: dispMove, supported: !!(view && view.scheduling) })
          : (activeMeta ? react.createElement(ProviderSettingsCard, { key: activeMeta.id, meta: activeMeta, on: activeOn, rank: rankOf[activeMeta.id], zh: zh, view: view.providers && view.providers[activeMeta.id], form: form[activeMeta.id] || {}, setField: setField, clears: clears, setClear: setClear }) : null),
        react.createElement("div", { className: "clbs-actions" },
          react.createElement("button", { className: "clbs-btn", type: "button", onClick: save, disabled: loading }, loading ? "保存中…" : "保存全部"),
          react.createElement("button", { className: "clbs-btn clbs-btn-ghost", type: "button", onClick: function () { setClears({}); reload(); } }, "重载"),
          msg ? react.createElement("span", { className: "clbs-msg " + (msg.kind === "ok" ? "clbs-msg-ok" : "clbs-msg-err") }, msg.text) : null));
    }

    function apply(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["slots"], function (scope) {
        const slots = scope.get("slots");
        if (slots === undefined) return;
        scope.slots.inject("conversation.session.header.utilities", function () {
          return slots.register({ name: "conversation.session.header.utilities", id: "cli-bridge-indicator-home", order: 50, inject: function (injectedSessionId) { return { injectedSessionId: injectedSessionId, sessionsSvc: scope.get("sessions") }; } }, function (props) { return react.createElement(Indicator, props); });
        });
        scope.slots.inject("settings.section", function () {
          return slots.register({ name: "settings.section", id: "cli-bridge-settings", order: 7, label: function () {
            try { return (String(navigator.language || "").toLowerCase().indexOf("zh") === 0) ? "CLI Bridge 桥接" : "CLI Bridge"; }
            catch (e) { return "CLI Bridge"; }
          } }, function () { return react.createElement(SettingsPanel, null); });
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
