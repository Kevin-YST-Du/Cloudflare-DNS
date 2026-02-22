/**
 * Cloudflare DNS Pro Editor - V3.5 (完美定制版)
 * 1. 优化：底部署名修改为指向 Github 的蓝色超链接
 * 2. 包含：D1/KV鉴权、智能补全、可视化双向同步、批量操作、蓝色SVG勾勾
 */

export default {
  async fetch(request, env) {
    const jsonRes = (obj) => new Response(JSON.stringify(obj), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });

    // --- 存储层核心逻辑 (D1 + KV 双驱) ---
    const initDB = async () => {
      if (env.DB) {
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS user_tokens (
              id TEXT PRIMARY KEY, token TEXT, created INTEGER, expiry INTEGER, boundAccountId TEXT, boundApiToken TEXT
            )
          `).run();
        } catch (e) { console.error("DB Init Failed:", e); }
      }
    };

    const getAllTokens = async () => {
      await initDB();
      let tokens = [];
      let loadedFromD1 = false;

      if (env.DB) {
        try {
          const { results } = await env.DB.prepare('SELECT * FROM user_tokens ORDER BY created ASC').all();
          if (results && results.length > 0) {
            tokens = results.map(row => ({
              id: row.id, token: row.token, created: row.created, expiry: row.expiry,
              boundAccountId: row.boundAccountId || row.boundaccountid,
              boundApiToken: row.boundApiToken || row.boundapitoken
            }));
            loadedFromD1 = true;
          }
        } catch (e) { console.error("D1 Read Error:", e); }
      }

      if (!loadedFromD1 && env.KV_STORAGE) {
        const kvTokens = await env.KV_STORAGE.get('user_tokens_list', { type: 'json' }) || [];
        if (kvTokens.length > 0) {
          tokens = kvTokens;
          if (env.DB) {
            for (const t of tokens) {
              try {
                await env.DB.prepare('INSERT OR IGNORE INTO user_tokens (id, token, created, expiry, boundAccountId, boundApiToken) VALUES (?, ?, ?, ?, ?, ?)')
                  .bind(t.id, t.token, t.created, t.expiry, t.boundAccountId, t.boundApiToken).run();
              } catch (e) {}
            }
          }
        }
      }
      return tokens;
    };

    const saveToken = async (tokenObj) => {
      await initDB();
      if (env.DB) {
        try {
          await env.DB.prepare('INSERT OR REPLACE INTO user_tokens (id, token, created, expiry, boundAccountId, boundApiToken) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(tokenObj.id, tokenObj.token, tokenObj.created, tokenObj.expiry, tokenObj.boundAccountId, tokenObj.boundApiToken).run();
        } catch (e) {}
      }
      if (env.KV_STORAGE) {
        let current = await getAllTokens();
        if (!current.find(t => t.id === tokenObj.id)) current.push(tokenObj);
        await env.KV_STORAGE.put('user_tokens_list', JSON.stringify(current));
      }
    };

    const deleteTokenById = async (id) => {
      await initDB();
      if (env.DB) {
        try { await env.DB.prepare('DELETE FROM user_tokens WHERE id = ?').bind(id).run(); } catch (e) {}
      }
      if (env.KV_STORAGE) {
        let current = await getAllTokens();
        const newTokens = current.filter(t => t.id !== id);
        await env.KV_STORAGE.put('user_tokens_list', JSON.stringify(newTokens));
      }
    };

    const generateComplexToken = async () => {
      const array = new Uint8Array(120);
      crypto.getRandomValues(array);
      const randomPart = Array.from(array, d => d.toString(16).padStart(2, '0')).join('');
      const uuid = crypto.randomUUID().replace(/-/g, '');
      return `tk_${uuid.slice(0, 8)}${randomPart}${uuid.slice(24)}`;
    };

    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const action = formData.get("action");

        let accountId = formData.get("accountId");
        let apiToken = formData.get("apiToken");
        const loginToken = formData.get("loginToken");
        let isRootAdmin = false;
        let isTokenUser = false;

        if (loginToken) {
          if (!env.KV_STORAGE && !env.DB) {
             return jsonRes({ success: false, errors: [{ message: "未绑定存储资源 (需绑定 KV_STORAGE 或 DB)" }] });
          }
          const tokens = await getAllTokens();
          const matchedToken = tokens.find(t => t.token === loginToken);

          if (!matchedToken) return jsonRes({ success: false, errors: [{ message: "无效的 Token (未找到)" }] });
          if (matchedToken.expiry !== -1 && Date.now() > matchedToken.expiry) return jsonRes({ success: false, errors: [{ message: "Token 已过期" }] });

          accountId = matchedToken.boundAccountId;
          apiToken = matchedToken.boundApiToken;
          isTokenUser = true;
        } else if (accountId && apiToken) {
          isRootAdmin = true;
        }

        const hasAuth = isRootAdmin || isTokenUser;

        if (['listTokens', 'createToken', 'deleteToken'].includes(action)) {
          if (!hasAuth) return jsonRes({ success: false, errors: [{ message: "权限验证失败" }] });

          if (action === 'listTokens') {
            let tokens = await getAllTokens();
            const now = Date.now();
            tokens.sort((a, b) => a.created - b.created);
            tokens = tokens.map(t => ({ ...t, boundApiToken: '***', isExpired: t.expiry !== -1 && now > t.expiry }));
            return jsonRes({ success: true, result: tokens });
          }

          if (action === 'createToken') {
            const expiryInput = parseInt(formData.get('expiryDays') || '-1');
            if (expiryInput > 365) return jsonRes({ success: false, errors: [{ message: "自定义天数不能超过 365 天" }] });
            const created = Date.now();
            let expiry = -1;
            if (expiryInput > 0) expiry = created + (expiryInput * 24 * 60 * 60 * 1000);
            const newToken = {
              id: crypto.randomUUID(), token: await generateComplexToken(),
              created: created, expiry: expiry, boundAccountId: accountId, boundApiToken: apiToken
            };
            await saveToken(newToken);
            return jsonRes({ success: true, result: newToken });
          }

          if (action === 'deleteToken') {
            await deleteTokenById(formData.get('tokenId'));
            return jsonRes({ success: true });
          }
        }

        if (!accountId || !apiToken) {
          if (action === 'verifyLogin') return jsonRes({ success: false, errors: [{ message: "Account ID 或 Token 不能为空" }] });
          return jsonRes({ success: false, errors: [{ message: "缺少认证信息" }] });
        }

        const authHeader = { 'Authorization': `Bearer ${apiToken}` };
        const safeFetch = async (url, options = {}) => {
          try {
            const res = await fetch(url, options);
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch (e) {
              if (res.status === 400 || res.status === 403) data = { success: false, errors: [{ message: "API Token 无效或权限不足 (需 Zone:Edit 权限)" }] };
              else data = { success: false, errors: [{ message: "API 响应异常: " + text.substring(0, 50) }] };
            }
            if (data && !data.success && data.errors && data.errors.length > 0) {
              const rawMsg = (data.errors[0].message || "").toString();
              if (rawMsg.includes("Invalid access token") || /permission/i.test(rawMsg)) {
                data.errors[0].message = "API Token 无效或缺少 DNS 编辑权限";
              }
            }
            return { ok: res.ok, status: res.status, data };
          } catch (err) {
            return { ok: false, data: { success: false, errors: [{ message: "网络请求失败: " + err.message }] } };
          }
        };

        if (action === 'verifyLogin') {
          const res = await safeFetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=1`, { headers: authHeader });
          if (res.ok) return jsonRes({ success: true, role: isRootAdmin ? 'root' : 'token' });
          const errorMsg = res.data.errors?.[0]?.message || "验证失败，请确认凭证并拥有 Zone 权限";
          return jsonRes({ success: false, errors: [{ message: errorMsg }] });
        }

        if (action === "listZones") {
          const res = await safeFetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=500`, { headers: authHeader });
          return jsonRes(res.data);
        }

        if (action === "fetchDns") {
          const zoneId = formData.get("zoneId");
          if (!zoneId) return jsonRes({ success: false, errors: [{ message: "未指定 Zone ID" }] });

          const res = await safeFetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=500`, { headers: authHeader });
          if (res.ok && res.data.success) {
            const records = res.data.result.map(r => ({
              id: r.id,
              type: r.type,
              name: r.name,
              content: r.content,
              proxied: r.proxied,
              ttl: r.ttl,
              comment: r.comment || ""
            }));
            const code = JSON.stringify(records, null, 2);
            return jsonRes({ success: true, code });
          }
          return jsonRes(res.data);
        }

        if (action === "deployDns") {
          const zoneId = formData.get("zoneId");
          const code = formData.get("code");
          if (!zoneId) return jsonRes({ success: false, errors: [{ message: "未指定 Zone ID" }] });

          let newRecords = [];
          try {
            newRecords = JSON.parse(code);
            if (!Array.isArray(newRecords)) throw new Error("Root must be an array");
          } catch (e) {
            return jsonRes({ success: false, errors: [{ message: "JSON 格式解析失败，请检查语法！" }] });
          }

          const currentRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=500`, { headers: authHeader }).then(r => r.json());
          if (!currentRes.success) return jsonRes(currentRes);
          
          const currentRecords = currentRes.result || [];
          const currentMap = new Map(currentRecords.map(r => [r.id, r]));
          const newMap = new Map(newRecords.filter(r => r.id).map(r => [r.id, r]));

          let actionErrors = [];
          let successCount = 0;

          for (const [id, record] of currentMap) {
            if (!newMap.has(id)) {
              const delRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${id}`, { method: 'DELETE', headers: authHeader }).then(r => r.json());
              if (!delRes.success) actionErrors.push(`删除 ${record.name} 失败: ${delRes.errors?.[0]?.message}`);
              else successCount++;
            }
          }

          for (const record of newRecords) {
            const body = {
              type: record.type,
              name: record.name,
              content: record.content,
              ttl: record.ttl || 1,
              proxied: !!record.proxied,
              comment: record.comment || ""
            };

            if (record.id && currentMap.has(record.id)) {
              const old = currentMap.get(record.id);
              if (old.type !== body.type || old.name !== body.name || old.content !== body.content || 
                  old.ttl !== body.ttl || old.proxied !== body.proxied || (old.comment||"") !== body.comment) {
                  
                const putRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`, { 
                  method: 'PUT', headers: { ...authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify(body) 
                }).then(r => r.json());
                
                if (!putRes.success) actionErrors.push(`更新 ${body.name} 失败: ${putRes.errors?.[0]?.message}`);
                else successCount++;
              }
            } else {
              const postRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, { 
                method: 'POST', headers: { ...authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify(body) 
              }).then(r => r.json());
              
              if (!postRes.success) actionErrors.push(`创建 ${body.name} 失败: ${postRes.errors?.[0]?.message}`);
              else successCount++;
            }
          }

          if (actionErrors.length > 0) {
            return jsonRes({ success: false, errors: [{ message: `同步存在异常:\n${actionErrors.join('\n')}` }] });
          }
          return jsonRes({ success: true, message: `DNS 同步完成！共执行 ${successCount} 项有效变更。` });
        }

      } catch (err) {
        return jsonRes({ success: false, errors: [{ message: `系统错误: ${err.message}` }] });
      }
    }

    return new Response(renderUI(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
};

function renderUI() {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Cloudflare DNS Pro Editor</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M12%202L2%2022H22L12%202Z%22%20stroke%3D%22%233B82F6%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
    <style>
      ::-webkit-scrollbar { width: 0px !important; height: 0px !important; background: transparent !important; }
      * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
      .hidden { display: none !important; }
      
      @keyframes fadeOutUp { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-20px); } }
      @keyframes fadeIn { from { opacity: 0; filter: blur(4px); } to { opacity: 1; filter: blur(0); } }
      @keyframes shake { 0%, 100% { transform: translateX(0); } 20%, 60% { transform: translateX(-5px); } 40%, 80% { transform: translateX(5px); } }

      .animate-fade-out { animation: fadeOutUp 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
      .animate-fade-in { animation: fadeIn 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
      .animate-shake { animation: shake 0.4s ease-in-out; }

      :root {
        --bg: #f1f5f9; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; 
        --input-bg: #f8fafc; --input-text: #1e293b; --btn-bg: #e2e8f0; 
        --error-red: #ef4444; --success-green: #10b981;
      }
      .dark {
        --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --border: #334155; 
        --input-bg: #0f172a; --input-text: #f8fafc; --btn-bg: #334155;
      }

      body { background-color: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; padding: 2rem 1rem; margin: 0; min-height: 100vh; display: flex; justify-content: center; transition: 0.3s; }
      .custom-content-wrapper { position: relative; width: 85% !important; max-width: 1400px; padding: 2rem; border-radius: 1.5rem; background: var(--card); border: 1px solid var(--border); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15); display: flex; flex-direction: column; opacity: 0; }
      @media (max-width: 768px) { .custom-content-wrapper { width: 100% !important; padding: 1.25rem; } }

      .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
      .header-title { font-size: 1.875rem; font-weight: 900; color: #2563eb; letter-spacing: -0.05em; text-transform: uppercase; }
      .header-actions { display: flex; align-items: center; gap: 0.75rem; }
      
      .action-icon-btn { width: 2.5rem; height: 2.5rem; display: flex; align-items: center; justify-content: center; border-radius: 0.75rem; background: var(--btn-bg); border: 1px solid var(--border); cursor: pointer; transition: all 0.2s; color: var(--text); }
      .action-icon-btn:hover { opacity: 0.8; transform: translateY(-1px); }

      input, select, textarea { background-color: var(--input-bg) !important; color: var(--input-text) !important; border: 1px solid var(--border) !important; outline: none; appearance: none; -webkit-appearance: none; }
      select { background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e"); background-position: right 0.5rem center; background-repeat: no-repeat; background-size: 1.5em 1.5em; padding-right: 2.5rem; }

      .editor-area-container { height: 60vh; border-radius: 0.75rem; border: 2px solid var(--border); overflow: hidden; margin: 0.5rem 0 1rem 0; position: relative; }
      #monaco-container { height: 100%; width: 100%; }
      #visual-container { height: 100%; width: 100%; overflow-y: auto; background: var(--bg); padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem;}

      /* 卡片保持清爽的蓝色风格 */
      .dns-card { background: var(--card); border: 2px solid var(--border); border-radius: 0.75rem; padding: 0.75rem 1rem; display: flex; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05); transition: all 0.2s; border-left-width: 5px; border-left-color: #cbd5e1; }
      .dns-card:hover { transform: translateY(-1px); box-shadow: 0 4px 8px rgba(0,0,0,0.08); border-color: #3b82f6; }
      .dark .dns-card { border-left-color: #475569; }
      
      /* 卡片选中时的淡蓝色高亮 */
      .dns-card.selected { border-color: #3b82f6; background: #eff6ff; border-left-color: #3b82f6; }
      .dark .dns-card.selected { background: #1e3a8a; border-color: #3b82f6; border-left-color: #3b82f6; }

      .dns-info { flex: 1; min-width: 0; margin-left: 0.75rem; cursor: pointer; }
      .dns-actions { display: flex; gap: 0.5rem; margin-left: 1rem; }
      .dns-badge-type { background: #eff6ff; color: #2563eb; font-weight: bold; padding: 0.15rem 0.5rem; border-radius: 0.375rem; font-size: 0.75rem; margin-right: 0.5rem; }
      .dark .dns-badge-type { background: #1e3a8a; color: #bfdbfe; }
      .dns-proxy-icon { display: inline-flex; align-items: center; font-size: 0.75rem; color: #f59e0b; margin-left: 0.5rem; font-weight: bold; }
      
      .dns-btn { padding: 0.4rem; border-radius: 0.5rem; cursor: pointer; transition: 0.2s; color: #64748b; background: var(--btn-bg); border: none; }
      .dns-btn:hover { background: #e2e8f0; color: #1e293b; }
      .dark .dns-btn:hover { background: #475569; color: #f8fafc; }

      /* 纯 CSS 蓝色勾勾复选框 (采用 SVG 背景，杜绝显示异常) */
      .cb-container { display: flex; align-items: center; justify-content: center; }
      .dns-cb {
        appearance: none;
        -webkit-appearance: none;
        width: 1.25rem;
        height: 1.25rem;
        border: 2px solid #cbd5e1;
        border-radius: 0.35rem;
        background-color: var(--card);
        cursor: pointer;
        position: relative;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        margin: 0;
        outline: none;
        background-position: center;
        background-repeat: no-repeat;
        background-size: 0%; /* 默认状态隐藏 SVG */
      }
      .dark .dns-cb { border-color: #475569; }
      .dns-cb:hover { border-color: #3b82f6; }
      
      /* 选中时：蓝色边框 + 蓝色 SVG 勾号图案 (白底蓝勾) */
      .dns-cb:checked {
        border-color: #3b82f6;
        background-color: var(--card); 
        background-size: 85%; /* 放大显示 SVG 对号 */
        background-image: url("data:image/svg+xml,%3csvg viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2.5-2.5a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z' fill='%233b82f6'/%3e%3c/svg%3e");
      }

      .toast { position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%); padding: 0.8rem 2rem; border-radius: 1rem; color: white; opacity: 0; transition: 0.3s; z-index: 2000; }
      .toast.show { opacity: 1; }
      .mobile-action-btn { font-size: 0.75rem; padding: 0.35rem 0.85rem; border-radius: 0.5rem; margin-right: 0.5rem; color: white; font-weight: bold; transition: opacity 0.2s; cursor: pointer; }
      .mobile-action-btn:active { transform: scale(0.95); }
      
      /* 底部署名样式调整 */
      .footer-signature { margin-top: 1.5rem; padding-top: 1.2rem; border-top: 1px solid var(--border); text-align: center; font-size: 0.875rem;}

      .modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 1000; display: none; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
      .modal-backdrop.active { display: flex; }
      .token-modal { background: var(--card); width: 90%; max-width: 800px; max-height: 90vh; border-radius: 1.5rem; padding: 2rem; overflow-y: auto; border: 1px solid var(--border); }
      .login-box { background: var(--card); width: 100%; max-width: 420px; padding: 2.5rem; border-radius: 2rem; border: 1px solid var(--border); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); text-align: center; transition: all 0.5s; position: relative; }
      .login-error-msg { color: var(--error-red); font-size: 0.875rem; margin-bottom: 1rem; font-weight: 600; display: none; }
      .tab-btn { padding: 0.75rem; flex: 1; border-bottom: 2px solid transparent; color: #94a3b8; font-weight: 600; cursor: pointer; transition: 0.2s; text-align: center;}
      .tab-btn.active { color: #2563eb; border-color: #2563eb; }
      .delete-box { background: var(--card); width: 100%; max-width: 360px; padding: 2rem; border-radius: 1.5rem; border: 1px solid var(--border); text-align: center; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); }
      .token-card { background: var(--input-bg); border: 1px solid var(--border); border-radius: 1rem; padding: 1rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; word-break: break-all; }
      .token-info { flex: 1; padding-right: 1rem; }
      .token-val { font-family: monospace; font-weight: bold; color: #3b82f6; cursor: pointer; margin-bottom: 0.25rem; }
      .token-meta { font-size: 0.75rem; color: #94a3b8; }
      .token-del-btn { color: #ef4444; cursor: pointer; padding: 0.5rem; border-radius: 0.5rem; transition: 0.2s; }
      .token-del-btn:hover { background: #fee2e2; }

      .toolbar-container { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 0.5rem; }
      .tool-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }
      
      .mode-switch { display: flex; background: var(--input-bg); border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; }
      .mode-btn { padding: 0.4rem 1rem; font-size: 0.8rem; font-weight: bold; color: var(--text); cursor: pointer; transition: 0.2s; }
      .mode-btn.active { background: #2563eb; color: white; }

      .toggle-checkbox:checked { right: 0; border-color: #3b82f6; }
      .toggle-checkbox:checked + .toggle-label { background-color: #3b82f6; }
    </style>
  </head>
  <body class="light">

    <div id="login-gateway" class="fixed inset-0 bg-slate-100 dark:bg-slate-900 z-[5000] flex items-center justify-center p-4">
      <div id="login-box-inner" class="login-box">
        <h1 class="text-3xl font-black mb-6 text-blue-600 tracking-tighter uppercase">CF DNS EDITOR</h1>
        <div class="flex mb-6 border-b border-slate-200 dark:border-slate-700">
          <div onclick="switchTab('admin')" id="tab-admin" class="tab-btn active">Root 登录</div>
          <div onclick="switchTab('token')" id="tab-token" class="tab-btn">Token 登录</div>
        </div>
        <div id="form-admin">
          <input id="login-aid" type="text" placeholder="Account ID" class="w-full p-4 mb-3 rounded-xl outline-none shadow-sm">
          <input id="login-key" type="password" placeholder="API Token (需 Zone 编辑权限)" class="w-full p-4 mb-6 rounded-xl outline-none shadow-sm">
        </div>
        <div id="form-token" class="hidden">
          <input id="login-ck" type="password" placeholder="粘贴 Access Token (tk_...)" class="w-full p-4 mb-6 rounded-xl outline-none shadow-sm text-center font-mono">
        </div>
        <div id="login-msg" class="login-error-msg"></div>
        <button onclick="doLogin()" id="login-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-bold text-lg shadow-lg active:scale-95 transition">进入系统</button>
      </div>
    </div>

    <div class="custom-content-wrapper" id="main-interface">

      <div class="header-row">
        <h1 class="header-title">CF DNS PRO EDITOR</h1>
        <div class="header-actions">
          <div id="user-badge" class="px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold whitespace-nowrap">未登录</div>
          <button id="btn-manage-token" onclick="openTokenModal()" class="action-icon-btn" title="Token 管理" style="color: #F59E0B;">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          </button>
          <button onclick="doLogout()" class="action-icon-btn" title="退出登录">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
          </button>
          <button onclick="toggleTheme()" class="action-icon-btn" id="theme-icon">☀️</button>
        </div>
      </div>

      <div class="flex gap-2 mb-4">
        <select id="zone-select" class="flex-1 p-4 rounded-xl text-lg outline-none cursor-pointer appearance-none font-bold text-blue-600">
          <option value="">-- 正在加载域名列表... --</option>
        </select>
        <button onclick="doAction('listZones')" class="bg-emerald-500 hover:bg-emerald-600 text-white px-6 rounded-xl font-black active:scale-95 transition">刷新域名</button>
      </div>

      <div class="toolbar-container">
        <div class="tool-row">
          <div class="flex items-center gap-3">
            <button onclick="doAction('fetchDns')" class="bg-blue-100 text-blue-700 hover:bg-blue-200 font-bold py-2 px-4 rounded-lg text-sm transition whitespace-nowrap">⬇️ 拉取 DNS</button>
            <div class="mode-switch">
              <div id="mode-visual" onclick="setEditorMode('visual')" class="mode-btn active">可视化</div>
              <div id="mode-json" onclick="setEditorMode('json')" class="mode-btn">JSON</div>
            </div>
          </div>
          
          <div id="toolbar-visual" class="flex flex-1 items-center gap-2 min-w-[200px] ml-auto">
             <input type="text" id="search-dns-input" oninput="renderDnsCards()" placeholder="🔍 搜索记录 (名称/内容/备注)..." class="flex-1 p-2 rounded-lg text-sm transition font-mono w-full min-w-[150px]">
             <button onclick="openDnsModal()" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded-lg text-sm transition shadow-md whitespace-nowrap">➕ 新增</button>
          </div>

          <div id="toolbar-json" class="flex hidden ml-auto gap-2">
            <button onclick="editorSelectAll()" class="mobile-action-btn bg-green-500 hover:bg-green-600 transition shadow-sm">全选</button>
            <button onclick="editorCopyAll()" class="mobile-action-btn bg-green-500 hover:bg-green-600 transition shadow-sm">复制</button>
            <button onclick="editorPaste()" class="mobile-action-btn bg-green-500 hover:bg-green-600 transition shadow-sm mr-0">粘贴</button>
          </div>
        </div>
        
        <div id="batch-actions-bar" class="flex items-center justify-between bg-white dark:bg-slate-800 p-3 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm transition">
           <div class="flex items-center gap-2">
              <input type="checkbox" id="select-all-cb" onchange="toggleSelectAll()" class="dns-cb">
              <label for="select-all-cb" class="text-sm font-bold text-slate-700 dark:text-slate-200 cursor-pointer select-none">全选过滤结果</label>
              <span id="selected-count-badge" class="ml-3 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-bold hidden">已选 0 项</span>
           </div>
           <div id="batch-btn-group" class="flex gap-2 opacity-50 pointer-events-none transition-opacity">
              <button onclick="openBatchEditModal()" class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded-lg text-xs font-bold transition shadow-sm">✏️ 批量修改</button>
              <button onclick="openBatchDeleteModal()" class="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded-lg text-xs font-bold transition shadow-sm">🗑️ 批量删除</button>
           </div>
        </div>

      </div>

      <div class="editor-area-container">
        <div id="visual-container">
           <div id="dns-card-list" class="text-center text-slate-400 py-10">请先拉取 DNS 记录</div>
        </div>
        <div id="monaco-container" class="hidden"></div>
      </div>

      <button id="p-btn" onclick="openDeployModal()" class="w-full mt-2 bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black text-xl shadow-2xl transition active:scale-95">
        🚀 同步部署 DNS (Diff Sync)
      </button>

      <div class="footer-signature">
        <a href="https://github.com/Kevin-YST-Du/Cloudflare-DNS" target="_blank" class="text-blue-500 hover:text-blue-600 hover:underline font-bold transition">Powered by Kevin-YST-Du/Cloudflare-DNS</a>
      </div>
    </div>

    <div id="batch-edit-modal" class="modal-backdrop">
      <div class="bg-white dark:bg-slate-900 w-full max-w-lg rounded-3xl p-6 border border-slate-200 shadow-2xl relative">
        <h3 class="text-xl font-black mb-4 text-slate-800 dark:text-slate-100 border-b border-slate-200 dark:border-slate-700 pb-3">批量修改 <span id="batch-edit-count" class="text-blue-500"></span> 项记录</h3>
        <p class="text-xs text-orange-500 mb-4 font-bold bg-orange-50 dark:bg-slate-800 p-2 rounded">💡 提示：留空的字段将保持原样，不作修改。</p>
        
        <div class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-500 mb-1">统一修改为名称 (Name)</label>
            <input id="batch-name" type="text" placeholder="留空则不修改。填 @ 自动补全为根域名" class="w-full p-3 rounded-lg font-mono">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 mb-1">统一修改内容/IP (Content)</label>
            <textarea id="batch-content" rows="2" placeholder="留空则不修改。例如: 1.1.1.1" class="w-full p-3 rounded-lg font-mono"></textarea>
          </div>
          <div class="flex gap-4">
            <div class="w-1/2">
              <label class="block text-xs font-bold text-slate-500 mb-1">统一修改 TTL</label>
              <select id="batch-ttl" class="w-full p-3 rounded-lg font-mono">
                <option value="ignore">-- 不修改 --</option>
                <option value="1">Auto (自动)</option>
                <option value="60">1 min</option>
                <option value="300">5 min</option>
                <option value="3600">1 hr</option>
                <option value="86400">1 day</option>
              </select>
            </div>
            <div class="w-1/2">
               <label class="block text-xs font-bold text-slate-500 mb-1">统一修改代理状态</label>
               <select id="batch-proxied" class="w-full p-3 rounded-lg font-mono">
                <option value="ignore">-- 不修改 --</option>
                <option value="true">开启 (Proxied) ☁️</option>
                <option value="false">关闭 (DNS Only)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="flex gap-3 mt-6">
          <button onclick="closeModal('batch-edit-modal')" class="flex-1 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 text-slate-600">取消</button>
          <button onclick="applyBatchEdit()" class="flex-1 py-3 rounded-xl font-bold bg-blue-600 text-white">确认批量修改</button>
        </div>
      </div>
    </div>

    <div id="dns-edit-modal" class="modal-backdrop">
      <div class="bg-white dark:bg-slate-900 w-full max-w-lg rounded-3xl p-6 border border-slate-200 shadow-2xl relative">
        <h3 id="dns-modal-title" class="text-xl font-black mb-4 text-slate-800 dark:text-slate-100 border-b border-slate-200 dark:border-slate-700 pb-3">新增 DNS 记录</h3>
        <input type="hidden" id="edit-record-index" value="-1">
        <input type="hidden" id="edit-record-id" value="">
        
        <div class="space-y-4">
          <div class="flex gap-4">
            <div class="w-1/3">
              <label class="block text-xs font-bold text-slate-500 mb-1">类型 (Type)</label>
              <select id="edit-type" class="w-full p-3 rounded-lg font-mono">
                <option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option>
                <option value="TXT">TXT</option><option value="MX">MX</option><option value="SRV">SRV</option>
              </select>
            </div>
            <div class="w-2/3">
              <label class="block text-xs font-bold text-slate-500 mb-1">名称 (Name)</label>
              <input id="edit-name" type="text" placeholder="填 @ 或短名称，会自动补全" class="w-full p-3 rounded-lg font-mono">
            </div>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 mb-1">内容 (Content)</label>
            <textarea id="edit-content" rows="2" placeholder="1.1.1.1 或 目标地址" class="w-full p-3 rounded-lg font-mono"></textarea>
          </div>
          <div class="flex gap-4 items-center">
            <div class="w-1/2">
              <label class="block text-xs font-bold text-slate-500 mb-1">TTL</label>
              <select id="edit-ttl" class="w-full p-3 rounded-lg font-mono">
                <option value="1">Auto (自动)</option><option value="60">1 min</option><option value="300">5 min</option><option value="3600">1 hr</option><option value="86400">1 day</option>
              </select>
            </div>
            <div class="w-1/2 flex items-center justify-end mt-4">
               <label class="text-sm font-bold text-slate-600 dark:text-slate-300 mr-3">代理状态</label>
               <div class="relative inline-block w-10 mr-2 align-middle select-none transition duration-200 ease-in">
                  <input type="checkbox" name="toggle" id="edit-proxied" class="toggle-checkbox absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer" style="top:0; right:16px; transition: all 0.2s;"/>
                  <label for="edit-proxied" class="toggle-label block overflow-hidden h-6 rounded-full bg-gray-300 cursor-pointer"></label>
               </div>
               <span class="text-orange-500 text-xl">☁️</span>
            </div>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 mb-1">备注 (Comment) - 选填</label>
            <input id="edit-comment" type="text" placeholder="备注信息" class="w-full p-3 rounded-lg">
          </div>
        </div>

        <div class="flex gap-3 mt-6">
          <button onclick="closeModal('dns-edit-modal')" class="flex-1 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 text-slate-600">取消</button>
          <button onclick="saveDnsRecord()" class="flex-1 py-3 rounded-xl font-bold bg-blue-600 hover:bg-blue-700 text-white">确认保存</button>
        </div>
      </div>
    </div>

    <div id="deploy-modal" class="modal-backdrop">
      <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-3xl p-8 border border-slate-200 text-center shadow-2xl">
        <div class="text-blue-500 mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto"><path d="M21 2v6h-6"></path><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M3 22v-6h6"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg>
        </div>
        <h3 class="text-2xl font-black mb-2 text-slate-800 dark:text-slate-100">确认同步部署？</h3>
        <p class="text-slate-500 text-sm mb-6">系统将自动校准域名格式，并对比差异执行安全的增删改操作。</p>
        <div class="flex gap-3">
          <button onclick="closeModal('deploy-modal')" class="flex-1 py-4 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 text-slate-600">取消</button>
          <button onclick="executeDeploy()" class="flex-1 py-4 rounded-xl font-bold bg-blue-600 text-white hover:bg-blue-700">执行变更</button>
        </div>
      </div>
    </div>

    <div id="batch-delete-modal" class="modal-backdrop">
      <div class="delete-box">
        <div class="text-red-500 mb-4"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></div>
        <h3 class="text-xl font-bold mb-2">确认批量删除?</h3>
        <p class="text-sm text-slate-500 mb-4">将从列表中删除选中的 <span id="batch-del-count" class="font-bold text-red-500"></span> 项记录。<br>(需点击同步部署后方才生效)</p>
        <div class="flex gap-3 mt-4">
          <button onclick="closeModal('batch-delete-modal')" class="flex-1 py-3 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 font-bold">取消</button>
          <button onclick="applyBatchDelete()" class="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold">确认删除</button>
        </div>
      </div>
    </div>

    <div id="token-modal" class="modal-backdrop">
      <div class="token-modal">
        <div class="flex justify-between items-center mb-6">
          <h2 class="text-2xl font-black text-blue-600">🔑 Token 分发中心</h2>
          <button onclick="closeModal('token-modal')" class="text-2xl opacity-50 hover:opacity-100">&times;</button>
        </div>
        <div class="p-6 rounded-xl bg-slate-100 dark:bg-slate-800 mb-8">
          <h4 class="font-bold mb-4">生成新 Token</h4>
          <div class="flex flex-col md:flex-row gap-3">
            <select id="token-expiry" onchange="toggleCustomExpiry()" class="p-3 rounded-lg flex-1">
              <option value="-1">永不过期</option><option value="1">1 天后过期</option><option value="7">7 天后过期</option><option value="custom">自定义天数...</option>
            </select>
            <input id="custom-days" type="number" min="1" max="365" placeholder="输入天数" class="p-3 rounded-lg flex-1 hidden border border-blue-400">
            <button onclick="generateToken()" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-bold transition">生成</button>
          </div>
        </div>
        <h4 class="font-bold mb-4">Token 列表</h4>
        <div id="token-list" class="space-y-3 max-h-[400px] overflow-y-auto"><div class="text-center text-slate-400 py-4">加载中...</div></div>
      </div>
    </div>
    
    <div id="delete-modal" class="modal-backdrop">
      <div class="delete-box">
        <div class="text-red-500 mb-4"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mx-auto"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></div>
        <h3 class="text-xl font-bold mb-2">确认删除?</h3>
        <div class="flex gap-3 mt-4">
          <button onclick="closeModal('delete-modal')" class="flex-1 py-3 rounded-xl bg-slate-100">取消</button>
          <button onclick="confirmDeleteToken()" class="flex-1 py-3 rounded-xl bg-red-600 text-white">删除</button>
        </div>
      </div>
    </div>
    <div id="toast" class="toast"></div>

    <script>
      const $ = id => document.getElementById(id);
      let editor = null;
      let authState = { mode: 'none', data: {} };
      let tokenToDelete = null;
      let currentMode = 'visual'; 
      let parsedDnsRecords = []; 
      
      let selectedIndices = new Set();
      let currentFilteredIndices = []; 

      function init() {
         checkUrlAndLogin(); 
         if (typeof require !== 'undefined') {
             require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
             require(['vs/editor/editor.main'], () => {
                const savedTheme = localStorage.getItem('theme');
                if(savedTheme === 'dark') { document.body.classList.add('dark'); $('theme-icon').innerText = '🌙'; }
                editor = monaco.editor.create($('monaco-container'), { 
                  value: '[]', language: 'json', automaticLayout: false, minimap: { enabled: false }, fontSize: 14, wordWrap: 'on', formatOnPaste: true,
                  theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs' 
                });
                new ResizeObserver(() => editor.layout()).observe($('monaco-container'));
                window.addEventListener('resize', () => editor.layout());
             });
         }
         
         $('edit-proxied').addEventListener('change', function() {
            if(this.checked) this.style.right = '0';
            else this.style.right = '16px';
         });
      }
      window.onload = init;

      function clearSelection() {
         selectedIndices.clear();
         $('select-all-cb').checked = false;
         updateBatchUI();
      }

      function updateBatchUI() {
         const count = selectedIndices.size;
         const badge = $('selected-count-badge');
         const group = $('batch-btn-group');
         if (count > 0) {
            badge.innerText = '已选 ' + count + ' 项';
            badge.classList.remove('hidden');
            group.classList.remove('opacity-50', 'pointer-events-none');
         } else {
            badge.classList.add('hidden');
            group.classList.add('opacity-50', 'pointer-events-none');
         }
         
         if(currentFilteredIndices.length > 0 && currentFilteredIndices.every(idx => selectedIndices.has(idx))) {
             $('select-all-cb').checked = true;
         } else {
             $('select-all-cb').checked = false;
         }
      }

      function toggleSelect(index, event) {
         if (event) event.stopPropagation();
         if (selectedIndices.has(index)) {
             selectedIndices.delete(index);
         } else {
             selectedIndices.add(index);
         }
         updateBatchUI();
         renderDnsCards(false); 
      }

      function toggleSelectAll() {
         const isChecked = $('select-all-cb').checked;
         if (isChecked) {
             currentFilteredIndices.forEach(idx => selectedIndices.add(idx));
         } else {
             currentFilteredIndices.forEach(idx => selectedIndices.delete(idx));
         }
         updateBatchUI();
         renderDnsCards(false);
      }

      function setEditorMode(mode) {
         if (mode === currentMode) return;
         
         if (mode === 'visual') {
            try {
               const val = editor.getValue().trim();
               parsedDnsRecords = val ? JSON.parse(val) : [];
               if (!Array.isArray(parsedDnsRecords)) throw new Error();
            } catch (e) {
               return showToast("JSON 格式错误，请修复后再切换可视化模式", true);
            }
            clearSelection();
            renderDnsCards();
            $('visual-container').classList.remove('hidden');
            $('monaco-container').classList.add('hidden');
            $('toolbar-visual').classList.remove('hidden');
            $('batch-actions-bar').classList.remove('hidden');
            $('toolbar-json').classList.add('hidden');
         } else {
            editor.setValue(JSON.stringify(parsedDnsRecords, null, 2));
            $('visual-container').classList.add('hidden');
            $('monaco-container').classList.remove('hidden');
            $('toolbar-visual').classList.add('hidden');
            $('batch-actions-bar').classList.add('hidden');
            $('toolbar-json').classList.remove('hidden');
            setTimeout(() => editor.getAction('editor.action.formatDocument').run(), 50);
         }
         
         $('mode-visual').classList.toggle('active', mode === 'visual');
         $('mode-json').classList.toggle('active', mode === 'json');
         currentMode = mode;
      }

      function syncEditorToMemory() {
         if(currentMode === 'json') {
            try { parsedDnsRecords = JSON.parse(editor.getValue()) || []; } catch(e){}
         }
      }

      function renderDnsCards(recalculateFiltered = true) {
         const list = $('dns-card-list');
         if (!parsedDnsRecords || parsedDnsRecords.length === 0) {
            list.innerHTML = '<div class="text-center text-slate-400 py-10 italic">记录为空，请拉取或添加新记录</div>';
            currentFilteredIndices = [];
            return;
         }

         if (recalculateFiltered) {
             const queryInput = $('search-dns-input');
             const query = queryInput ? queryInput.value.trim().toLowerCase() : '';
             
             currentFilteredIndices = parsedDnsRecords.map((r, i) => ({ r, index: i })).filter(item => {
                 if (!query) return true;
                 const r = item.r;
                 return (r.name && r.name.toLowerCase().includes(query)) ||
                        (r.content && r.content.toLowerCase().includes(query)) ||
                        (r.type && r.type.toLowerCase().includes(query)) ||
                        (r.comment && r.comment.toLowerCase().includes(query));
             }).map(item => item.index);
         }

         if (currentFilteredIndices.length === 0) {
            list.innerHTML = '<div class="text-center text-slate-400 py-10 italic">没有找到匹配的记录</div>';
            return;
         }
         
         list.innerHTML = currentFilteredIndices.map(originalIndex => {
            const r = parsedDnsRecords[originalIndex];
            const isProxy = r.proxied ? '<span class="dns-proxy-icon" title="Proxied">☁️ 代理</span>' : '<span class="text-xs text-slate-400 ml-2">仅 DNS</span>';
            const ttlStr = r.ttl === 1 ? 'Auto' : r.ttl;
            const contentShort = r.content && r.content.length > 40 ? r.content.substring(0,40) + '...' : r.content;
            
            const isSelected = selectedIndices.has(originalIndex);
            const cardClass = isSelected ? 'dns-card selected' : 'dns-card';
            
            return \`
               <div class="\${cardClass}" onclick="toggleSelect(\${originalIndex}, event)">
                  <div class="cb-container mr-2">
                     <input type="checkbox" class="dns-cb" \${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleSelect(\${originalIndex}, event)">
                  </div>
                  <div class="dns-info">
                     <div class="flex items-center mb-1">
                        <span class="dns-badge-type">\${r.type}</span>
                        <span class="font-bold font-mono text-sm">\${r.name}</span>
                        \${isProxy}
                     </div>
                     <div class="text-xs text-slate-500 font-mono break-all">
                        指向: <span class="text-slate-700 dark:text-slate-300">\${contentShort}</span> | TTL: \${ttlStr}
                        \${r.comment ? '<br><span class="text-blue-500">📝 ' + r.comment + '</span>' : ''}
                     </div>
                  </div>
                  <div class="dns-actions" onclick="event.stopPropagation()">
                     <button class="dns-btn" onclick="openDnsModal(\${originalIndex})" title="单条编辑">✏️</button>
                     <button class="dns-btn hover:bg-red-100 hover:text-red-600" onclick="deleteDnsRecord(\${originalIndex})" title="单条删除">🗑️</button>
                  </div>
               </div>
            \`;
         }).join('');
         
         updateBatchUI();
      }

      function openBatchEditModal() {
          if(selectedIndices.size === 0) return;
          $('batch-edit-count').innerText = selectedIndices.size;
          $('batch-name').value = '';
          $('batch-content').value = '';
          $('batch-ttl').value = 'ignore';
          $('batch-proxied').value = 'ignore';
          $('batch-edit-modal').classList.add('active');
      }

      function applyBatchEdit() {
          const newName = $('batch-name').value.trim();
          const newContent = $('batch-content').value.trim();
          const newTtl = $('batch-ttl').value;
          const newProxied = $('batch-proxied').value;

          const zoneName = $('zone-select').options[$('zone-select').selectedIndex].text;

          selectedIndices.forEach(idx => {
              let r = parsedDnsRecords[idx];
              
              if (newContent) r.content = newContent;
              if (newTtl !== 'ignore') r.ttl = parseInt(newTtl) || 1;
              if (newProxied === 'true') r.proxied = true;
              else if (newProxied === 'false') r.proxied = false;

              if (newName) {
                 let inputName = newName;
                 if (inputName === '@') inputName = zoneName;
                 else if (!inputName.endsWith(zoneName)) inputName = inputName.endsWith('.') ? inputName + zoneName : inputName + '.' + zoneName;
                 r.name = inputName;
              }
          });

          editor.setValue(JSON.stringify(parsedDnsRecords, null, 2));
          clearSelection();
          renderDnsCards(true);
          closeModal('batch-edit-modal');
          showToast("批量修改已保存 (需同步部署生效)");
      }

      function openBatchDeleteModal() {
          if(selectedIndices.size === 0) return;
          $('batch-del-count').innerText = selectedIndices.size;
          $('batch-delete-modal').classList.add('active');
      }

      function applyBatchDelete() {
          const indicesToDelete = Array.from(selectedIndices).sort((a, b) => b - a);
          indicesToDelete.forEach(idx => {
              parsedDnsRecords.splice(idx, 1);
          });
          
          editor.setValue(JSON.stringify(parsedDnsRecords, null, 2));
          clearSelection();
          renderDnsCards(true);
          closeModal('batch-delete-modal');
          showToast("批量删除成功 (需同步部署生效)");
      }

      function openDnsModal(index = -1) {
         if (!$('zone-select').value) return showToast("请先选择域名并拉取记录", true);
         if (currentMode === 'json') syncEditorToMemory();
         
         $('edit-record-index').value = index;
         const ck = $('edit-proxied');
         
         if (index === -1) {
            $('dns-modal-title').innerText = "添加 DNS 记录";
            $('edit-record-id').value = "";
            $('edit-type').value = "A";
            $('edit-name').value = "";
            $('edit-content').value = "";
            $('edit-ttl').value = "1";
            $('edit-comment').value = "";
            ck.checked = false; ck.style.right = '16px';
         } else {
            $('dns-modal-title').innerText = "修改 DNS 记录";
            const r = parsedDnsRecords[index]; 
            $('edit-record-id').value = r.id || "";
            $('edit-type').value = r.type;
            $('edit-name').value = r.name;
            $('edit-content').value = r.content;
            
            const ttlSelect = $('edit-ttl');
            if(!Array.from(ttlSelect.options).find(o => o.value == r.ttl)) {
                ttlSelect.add(new Option(r.ttl, r.ttl));
            }
            ttlSelect.value = r.ttl;
            
            $('edit-comment').value = r.comment || "";
            ck.checked = !!r.proxied;
            ck.style.right = ck.checked ? '0' : '16px';
         }
         $('dns-edit-modal').classList.add('active');
      }

      function saveDnsRecord() {
         const index = parseInt($('edit-record-index').value);
         
         let inputName = $('edit-name').value.trim();
         const zoneName = $('zone-select').options[$('zone-select').selectedIndex].text;
         if (inputName === '@') {
             inputName = zoneName;
         } else if (inputName && !inputName.endsWith(zoneName)) {
             inputName = inputName.endsWith('.') ? inputName + zoneName : inputName + '.' + zoneName;
         }

         const newRecord = {
            type: $('edit-type').value,
            name: inputName,
            content: $('edit-content').value.trim(),
            ttl: parseInt($('edit-ttl').value) || 1,
            proxied: $('edit-proxied').checked,
         };
         
         const comment = $('edit-comment').value.trim();
         if(comment) newRecord.comment = comment;
         
         const id = $('edit-record-id').value;
         if(id) newRecord.id = id;
         
         if(!newRecord.name || !newRecord.content) return showToast("名称和内容不能为空", true);

         if(index === -1) {
            parsedDnsRecords.unshift(newRecord); 
         } else {
            parsedDnsRecords[index] = newRecord;
         }
         
         if (currentMode === 'visual') {
            renderDnsCards();
         } else {
            editor.setValue(JSON.stringify(parsedDnsRecords, null, 2));
         }
         
         closeModal('dns-edit-modal');
         showToast("已保存 (需点击同步部署才能生效)");
      }

      function deleteDnsRecord(index) {
         parsedDnsRecords.splice(index, 1);
         selectedIndices.delete(index);
         let newSelections = new Set();
         selectedIndices.forEach(idx => {
             if (idx > index) newSelections.add(idx - 1);
             else newSelections.add(idx);
         });
         selectedIndices = newSelections;
         
         renderDnsCards(true); 
         showToast("已删除该行 (需点击同步部署生效)");
      }

      async function doAction(action, extra = {}) {
        const zoneId = $('zone-select').value;
        if ((action === 'fetchDns' || action === 'deployDns') && !zoneId) return showToast("请先选择域名", true);
        
        const res = await apiCall({ action, zoneId, ...extra });
        if(res.success || res.result) {
            if(action === 'listZones') { 
                $('zone-select').innerHTML = res.result.map(z => \`<option value="\${z.id}">\${z.name}</option>\`).join(''); 
                showToast("域名已更新"); 
            }
            else if(action === 'fetchDns') { 
                parsedDnsRecords = JSON.parse(res.code || '[]');
                
                const queryInput = $('search-dns-input');
                if (queryInput) queryInput.value = '';
                clearSelection();

                if(editor) {
                    editor.getModel().setValue(res.code || '[]');
                    setTimeout(() => editor.getAction('editor.action.formatDocument').run(), 100);
                }
                if(currentMode === 'visual') renderDnsCards();
                showToast("DNS 拉取成功"); 
            }
            else if(action === 'deployDns') {
                showToast(res.message || "部署成功");
                setTimeout(() => doAction('fetchDns'), 1500);
            }
        } else {
            showToast(res.errors?.[0]?.message || "请求失败", true);
        }
        return res;
      }

      function checkUrlAndLogin() { const u = new URLSearchParams(location.search).get('token'); const p = location.pathname; if(p.startsWith('/tk_')||u){ switchTab('token'); $('login-ck').value=u||p.substring(1); const b=$('login-btn'); b.innerText="验证中..."; b.disabled=true; showToast("检测到 Token...", false); setTimeout(doLogin, 500); } else checkLogin(); }
      function checkLogin() { const sess = localStorage.getItem('wpe_session'); if(sess) { authState = JSON.parse(sess); showInterface(); } else { $('login-gateway').classList.remove('hidden'); } }
      function switchTab(tab) { $('tab-admin').classList.toggle('active', tab==='admin'); $('tab-token').classList.toggle('active', tab==='token'); $('form-admin').classList.toggle('hidden', tab!=='admin'); $('form-token').classList.toggle('hidden', tab!=='token'); $('login-msg').style.display='none'; }
      async function apiCall(data) { const fd = new FormData(); for(let k in data) fd.append(k, data[k]); if(data.action!=='verifyLogin'&&authState.mode!=='none'){ if(authState.mode==='token') fd.append('loginToken', authState.data.loginToken); else { fd.append('accountId', authState.data.accountId); fd.append('apiToken', authState.data.apiToken); } } return await (await fetch(location.href, { method: 'POST', body: fd })).json(); }
      
      async function doLogin() {
          const isT = $('tab-token').classList.contains('active'); const b = $('login-btn'); const orig = "进入系统"; b.innerText="验证中..."; b.disabled=true;
          let p = { action: 'verifyLogin' };
          if(isT) { p.loginToken=$('login-ck').value.trim(); if(!p.loginToken){ b.innerText=orig; b.disabled=false; return showToast("请输入 Token", true); } }
          else { p.accountId=$('login-aid').value.trim(); p.apiToken=$('login-key').value.trim(); if(!p.accountId||!p.apiToken){ b.innerText=orig; b.disabled=false; return showToast("请输入凭证", true); } }
          try { const res = await apiCall(p); if(res.success) { authState = { mode: isT?'token':'root', data: p }; localStorage.setItem('wpe_session', JSON.stringify(authState)); showInterface(); } else { showToast(res.errors?.[0]?.message||"验证失败", true); b.innerText=orig; b.disabled=false; } } catch(e) { showToast("网络失败", true); b.innerText=orig; b.disabled=false; }
      }
      
      function showInterface() { 
          const badge = $('user-badge');
          if(authState.mode === 'root') {
              badge.innerHTML = "Root 管理员";
              badge.className = "px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold whitespace-nowrap";
          } else if (authState.mode === 'token') {
              badge.innerHTML = "Token 管理员";
              badge.className = "px-3 py-1 bg-green-100 text-green-700 rounded-lg text-xs font-bold border border-green-200 whitespace-nowrap";
          }
      
          $('login-gateway').classList.add('animate-fade-out'); 
          setTimeout(() => { 
              $('login-gateway').classList.add('hidden'); 
              $('main-interface').classList.add('animate-fade-in'); 
              doAction('listZones'); 
          }, 450); 
      }
      
      function doLogout() { localStorage.removeItem('wpe_session'); location.reload(); }
      function toggleTheme() { const d = document.body.classList.toggle('dark'); if(editor) monaco.editor.setTheme(d?'vs-dark':'vs'); localStorage.setItem('theme', d?'dark':'light'); }
      function editorSelectAll() { if(editor){ editor.focus(); editor.setSelection(editor.getModel().getFullModelRange()); } }
      function editorCopyAll() { if(editor) navigator.clipboard.writeText(editor.getValue()).then(()=>showToast("已复制")); }
      async function editorPaste() { if(editor) try { const t = await navigator.clipboard.readText(); if(t) { editor.executeEdits('p', [{range:editor.getSelection(), text:t}]); setTimeout(()=>editor.getAction('editor.action.formatDocument').run(),50); } } catch(e){showToast("粘贴拦截",true);} }
      
      function openDeployModal() { if(!$('zone-select').value) return showToast("请先选择域名", true); $('deploy-modal').classList.add('active'); }
      
      async function executeDeploy() { 
          closeModal('deploy-modal'); 
          $('p-btn').disabled=true; $('p-btn').innerText="⌛ 正在同步对比中..."; 
          
          try {
              let codeStr = editor ? editor.getValue() : '[]';
              let records = JSON.parse(codeStr);
              if (Array.isArray(records)) {
                  const zoneName = $('zone-select').options[$('zone-select').selectedIndex].text;
                  let modified = false;
                  records = records.map(r => {
                      if (r.name) {
                          let orig = r.name;
                          if (r.name === '@') r.name = zoneName;
                          else if (!r.name.endsWith(zoneName)) r.name = r.name.endsWith('.') ? r.name + zoneName : r.name + '.' + zoneName;
                          if (orig !== r.name) modified = true;
                      }
                      return r;
                  });
                  
                  parsedDnsRecords = records;
                  codeStr = JSON.stringify(parsedDnsRecords, null, 2);
                  editor.setValue(codeStr);
                  if (currentMode === 'visual') renderDnsCards();
              }
              await doAction('deployDns', { code: editor.getValue() }); 
          } catch(e) {
              showToast("JSON 解析失败，请检查格式", true);
          }
          
          $('p-btn').disabled=false; $('p-btn').innerText="🚀 同步部署 DNS (Diff Sync)"; 
      }
      
      function closeModal(id) { $(id).classList.remove('active'); }
      function showToast(m, isE=false) { const t=$('toast'); t.innerText=m; t.className='toast '+(isE?'bg-red-500':'bg-emerald-600')+' show'; setTimeout(()=>t.classList.remove('show'),3000); }
      
      function openTokenModal() { $('token-modal').classList.add('active'); fetchTokens(); }
      async function fetchTokens() { const r = await apiCall({action:'listTokens'}); if(r.success) renderTokenList(r.result); }
      
      function renderTokenList(t) { 
          $('token-list').innerHTML = t.map(tk=>\`<div class="token-card"><div><div class="font-bold text-blue-500 cursor-pointer" onclick="navigator.clipboard.writeText('\${tk.token}');showToast('已复制')">\${tk.token}</div></div></div>\`).join(''); 
      }
      
      function toggleCustomExpiry() { $('custom-days').classList.toggle('hidden', $('token-expiry').value !== 'custom'); }
      async function generateToken() { let e=$('token-expiry').value; if(e==='custom')e=$('custom-days').value; const r=await apiCall({action:'createToken',expiryDays:e}); if(r.success) {showToast("生成成功");fetchTokens();} }
      function openDeleteModal(id) { tokenToDelete=id; $('delete-modal').classList.add('active'); }
      async function confirmDeleteToken() { if(tokenToDelete) { await apiCall({action:'deleteToken',tokenId:tokenToDelete}); closeModal('delete-modal'); fetchTokens(); } }
    </script>
  </body>
  </html>
  `;
}
