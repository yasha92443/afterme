// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Browser-only helpers. Drafts and credentials remain in memory, never localStorage.
export function adminEnhancementsMarkup() {
  return `<dialog id="admin-session-dialog" class="admin-dialog" aria-labelledby="session-title">
    <form id="admin-session-form"><h2 id="session-title">继续编辑</h2><p>登录已过期，未保存的文字仍在当前页面。重新登录后继续操作。</p>
    <label for="session-secret">管理登录口令</label><input id="session-secret" type="password" autocomplete="current-password" required>
    <p id="session-error" role="alert"></p><button type="submit">登录并继续</button><button type="button" data-session-cancel class="secondary">稍后登录</button></form>
  </dialog>
  <dialog id="apply-review-dialog" class="admin-dialog" aria-labelledby="apply-review-title"><h2 id="apply-review-title">应用前核对</h2><p>以下草稿修改将保存为正式版本；公开状态按释放规则推进。</p><ul id="apply-change-list"></ul><button type="button" data-apply-confirm>应用这些修改</button><button type="button" class="secondary" data-apply-cancel>返回编辑</button></dialog>
  <dialog id="edit-conflict-dialog" class="admin-dialog" aria-labelledby="conflict-title"><h2 id="conflict-title">其他页面已有修改</h2>
    <p>两个版本都保留在这里。选择要保存的版本；取消后，当前输入仍保留。</p><div class="conflict-columns">
    <label>当前页面的文字<textarea id="conflict-local" readonly></textarea></label><label>系统已保存的文字<textarea id="conflict-remote" readonly></textarea></label></div>
    <button type="button" data-conflict-choice="local">保存我的修改</button><button type="button" data-conflict-choice="remote" class="secondary">使用已保存版本</button><button type="button" data-conflict-choice="cancel" class="secondary">暂不处理</button>
  </dialog>
  <p id="session-notice" class="warning" hidden>登录已过期，文字仍保留。<button type="button" id="session-unlock">重新登录</button></p>
  <script>${adminEnhancementsScript()}</script>`;
}

export function adminEnhancementsScript() {
  return String.raw`(() => {
    const nativeFetch = window.fetch.bind(window);
    const sessionDialog = document.getElementById('admin-session-dialog');
    const conflictDialog = document.getElementById('edit-conflict-dialog');
    const notice = document.getElementById('session-notice');
    let token = document.querySelector('input[name="admin_token"]')?.value || '';
    let expiryTimer, loginPending, resolveLogin, rejectLogin;
    let conflictQueue = Promise.resolve();
    function installToken(next) {
      token = next;
      document.querySelectorAll('input[name="admin_token"]').forEach(input => input.value = next);
      notice.hidden = Boolean(next);
      clearTimeout(expiryTimer);
      if (next.startsWith('session.')) expiryTimer = setTimeout(() => {
        token = ''; notice.hidden = false;
        document.querySelectorAll('input[name="admin_token"]').forEach(input => input.value = '');
      }, Math.max(0, Number(next.split('.')[1]) - Date.now()));
    }
    function unlock() {
      if (loginPending) return loginPending;
      loginPending = new Promise((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
      sessionDialog.showModal();
      document.getElementById('session-secret').focus();
      return loginPending;
    }
    function cancelLogin() {
      const reject = rejectLogin; loginPending = null; resolveLogin = rejectLogin = null;
      document.getElementById('session-secret').value = ''; sessionDialog.close();
      delete document.getElementById('admin-session-form').dataset.unsaved;
      reject?.(new Error('登录尚未恢复，当前输入仍保留。'));
    }
    sessionDialog.addEventListener('cancel', event => { event.preventDefault(); cancelLogin(); });
    sessionDialog.querySelector('[data-session-cancel]').addEventListener('click', cancelLogin);
    document.getElementById('session-unlock').addEventListener('click', () => unlock().catch(() => {}));
    if(!document.getElementById('session-mfa')){const field=document.createElement('input');field.id='session-mfa';field.autocomplete='one-time-code';field.placeholder='TOTP / recovery code';document.getElementById('session-secret').after(field);}
    document.getElementById('admin-session-form').addEventListener('submit', async event => {
      event.preventDefault();
      const secret = document.getElementById('session-secret');
      const button = event.submitter; button.disabled = true;
      try {
        const response = await nativeFetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_token: secret.value, mfa_code: document.getElementById('session-mfa').value }) });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || '登录失败，请重试。');
        installToken(result.token); secret.value = ''; sessionDialog.close();
        delete document.getElementById('admin-session-form').dataset.unsaved;
        const resolve = resolveLogin; loginPending = null; resolveLogin = rejectLogin = null;
        document.getElementById('session-error').textContent = ''; resolve?.(result.token);
      } catch (error) { document.getElementById('session-error').textContent = error.message; }
      finally { secret.value = ''; button.disabled = false; }
    });
    window.fetch = async (input, init) => {
      let request = new Request(input instanceof Request ? input : new URL(input, location.href), init);
      const url = new URL(request.url);
      if (url.origin !== location.origin || url.pathname === '/api/session') return nativeFetch(request);
      const contentType = request.headers.get('Content-Type') || '';
      let data = null;
      if (request.method === 'POST' && /form-urlencoded|multipart\/form-data/.test(contentType)) data = await request.clone().formData();
      const bearer = request.headers.get('Authorization');
      const protectedRequest = data?.has('admin_token') || bearer?.startsWith('Bearer session.');
      if (!protectedRequest) return nativeFetch(request);
      if (!token) await unlock();
      function authenticated() {
        const headers = new Headers(request.headers);
        if (bearer) headers.set('Authorization', 'Bearer ' + token);
        if (data) { data.set('admin_token', token); headers.delete('Content-Type'); }
        return new Request(request.clone(), { headers, ...(data ? { body: data } : {}) });
      }
      let response = await nativeFetch(authenticated());
      if (response.status === 401) { installToken(''); await unlock(); response = await nativeFetch(authenticated()); }
      return response;
    };
    function fieldsFor(current) {
      if ('plaintext' in current) return { plaintext: current.plaintext, recipient_id: current.recipient_id };
      if ('draft_body' in current) return { body: current.draft_body, group_id: current.draft_group_id, is_public: current.draft_is_public };
      return { title: current.draft_title, epigraph: current.draft_epigraph };
    }
    function resolveConflict(form, current) {
      const task = conflictQueue.catch(() => {}).then(() => new Promise(resolve => {
        const values = fieldsFor(current);
        const describe = entries => entries.map(([name, value]) => ({ body: '正文', plaintext: '正文', title: '标题', epigraph: '题辞', group_id: '分组', is_public: '用于公开', recipient_id: '收件人' }[name] || name) + '：' + value).join('\n\n');
        document.getElementById('conflict-local').value = describe(Object.keys(values).map(name => [name, form.elements.namedItem(name)?.value || '']));
        document.getElementById('conflict-remote').value = describe(Object.entries(values));
        function finish(choice) {
          conflictDialog.removeEventListener('click', clicked); conflictDialog.removeEventListener('cancel', cancelled); conflictDialog.close();
          if (choice !== 'cancel') {
            form.elements.namedItem('expected_revision').value = current.revision;
            if (choice === 'remote') Object.entries(values).forEach(([name,value]) => { const field = form.elements.namedItem(name); if (field) field.value = value; });
          }
          resolve(choice !== 'cancel');
        }
        function clicked(event) { const choice = event.target.closest('[data-conflict-choice]')?.dataset.conflictChoice; if (choice) finish(choice); }
        function cancelled(event) { event.preventDefault(); finish('cancel'); }
        conflictDialog.addEventListener('click', clicked); conflictDialog.addEventListener('cancel', cancelled); conflictDialog.showModal();
      }));
      conflictQueue = task; return task;
    }
    window.aftermeSubmit = async (form, initialData = new FormData(form)) => {
      let data = initialData;
      while (true) {
        const response = await fetch(form.action, { method: 'POST', body: data });
        const result = await response.json().catch(() => ({}));
        if(response.status===409&&Number.isSafeInteger(result.current?.draft_revision))throw new Error('草稿已在另一页面修改。输入仍保留；请重新核对草稿后再应用或放弃。');
        if (response.status !== 409 || result.error !== 'edit_conflict') {
          if (response.ok && result.revision !== undefined&&form.elements.namedItem('expected_revision')) form.elements.namedItem('expected_revision').value = result.revision;
          const root=document.getElementById('public-farewell-v2');if(response.ok&&root){if(Number.isSafeInteger(result.draft_revision))root.dataset.draftRevision=result.draft_revision;else if(form.matches('.farewell-autosave')&&result.changed)root.dataset.draftRevision=Number(root.dataset.draftRevision)+1;root.querySelectorAll('[name=expected_draft_revision]').forEach(input=>input.value=root.dataset.draftRevision);}
          return { response, result, data };
        }
        if (!await resolveConflict(form, result.current)) throw new Error('版本冲突尚未处理，输入仍保留。');
        data = new FormData(form);
      }
    };
    window.aftermeBindFields = root => {
      root.querySelectorAll('label:not([for])').forEach((label, index) => {
        if (label.querySelector('input,select,textarea')) return;
        const field = label.nextElementSibling;
        if (!field?.matches('input,select,textarea')) return;
        if (!field.id) field.id = 'field-' + crypto.randomUUID();
        label.htmlFor = field.id;
      });
    };
    window.aftermeBindFields(document);
    window.aftermeReviewApply = async () => {
      const response = await fetch('/api/public-farewell-v2/changes', { method: 'POST', body: new URLSearchParams({ admin_token: token }) });
      if (!response.ok) throw new Error('无法读取修改摘要，请稍后重试。');
      const result = await response.json();
      document.querySelectorAll('#public-farewell-v2 [name=expected_draft_revision]').forEach(input=>input.value=result.draft_revision);
      const dialog = document.getElementById('apply-review-dialog');
      const list = document.getElementById('apply-change-list'); list.replaceChildren();
      for (const change of result.changes || []) { const li=document.createElement('li'); li.textContent=change.label+' · '+change.changes.join('、'); list.append(li); }
      if (!result.pending_count) { const li=document.createElement('li'); li.textContent='正式版本已同步，待应用修改为 0。'; list.append(li); }
      return new Promise(resolve => {
        const confirm=dialog.querySelector('[data-apply-confirm]'); const cancel=dialog.querySelector('[data-apply-cancel]');
        function finish(value) { dialog.close(); confirm.removeEventListener('click',yes); cancel.removeEventListener('click',no); dialog.removeEventListener('cancel',esc); resolve(value); }
        function yes() { finish(true); } function no() { finish(false); } function esc(event) { event.preventDefault(); no(); }
        confirm.addEventListener('click',yes); cancel.addEventListener('click',no); dialog.addEventListener('cancel',esc); dialog.showModal();
      });
    };
    installToken(token);
    const main = document.querySelector('body > main');
    const nav = document.querySelector('.admin-nav');
    const views = {};
    for (const name of ['dashboard', 'contacts', 'letters', 'farewell', 'notifications', 'maintenance']) {
      const view = document.createElement('div'); view.dataset.adminView = name; views[name] = view;
    }
    for (const child of [...main.children]) {
      if (child.matches('header,nav,.readiness,script,dialog,#session-notice')) continue;
      const title = child.querySelector('h2')?.textContent || '';
      let name = 'dashboard';
      if (child.id === 'contacts-editor' || child.id === 'recipients-editor' || /联系人|确认记录|演练与故障/.test(title)) name = 'contacts';
      if (child.id === 'private-items-editor') name = 'letters';
      if (child.id === 'public-farewell-v2') name = 'farewell';
      if (child.id === 'mail-template-editor' || title === '邮件通道测试') name = 'notifications';
      if (/法律遗嘱|备份导出|PDF 维护|投递日志|高敏感/.test(title)) name = 'maintenance';
      views[name].append(child);
    }
    for (const view of Object.values(views)) main.append(view);
    views.dashboard.prepend(document.getElementById('owner-status'));
    const maintenance = document.createElement('a'); maintenance.href = '#maintenance'; maintenance.textContent = '备份与维护'; nav.insertBefore(maintenance, nav.querySelector('.logout'));
    views.maintenance.id = 'maintenance';
    function chooseView() {
      const id = decodeURIComponent(location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      const selected = target?.closest('[data-admin-view]')?.dataset.adminView || 'dashboard';
      Object.entries(views).forEach(([name,view]) => { view.hidden = name !== selected; });
      nav.querySelectorAll('a:not(.logout)').forEach(link => {
        const destination = document.getElementById(link.hash.slice(1));
        if (destination?.closest('[data-admin-view]')?.dataset.adminView === selected) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
      });
    }
    window.addEventListener('hashchange', chooseView); chooseView();
    new ResizeObserver(() => document.documentElement.style.setProperty('--admin-nav-height', nav.getBoundingClientRect().height + 12 + 'px')).observe(nav);
    document.addEventListener('submit', async event => {
      const form = event.target;
      if (form.matches('#admin-session-form')) return;
      if (form.matches('[data-backup-form]')) {
        event.preventDefault();
        const status = document.getElementById('backup-status'); const button = event.submitter; button.disabled = true;
        try {
          const response = await fetch(form.action, { method:'POST', body:new FormData(form) });
          if (!response.ok) throw new Error('导出失败，请重试。');
          const blob = await response.blob(); const download = document.createElement('a'); download.href = URL.createObjectURL(blob);
          const date = new Date().toISOString().slice(0,10);
          download.download = form.dataset.backupKind === 'complete' ? 'afterme-recovery-backup-' + date + '.json' : 'afterme-metadata-' + date + '.json';
          const objectUrl = download.href; download.hidden = true; document.body.append(download); download.click(); download.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
          if (form.dataset.backupKind === 'complete') {
            document.getElementById('last-complete-backup').textContent = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replaceAll('/', '-') + ' (UTC+8)';
            document.querySelector('[data-no-complete-backup]')?.remove();
          }
          status.textContent = form.dataset.backupKind === 'complete' ? '完整备份已生成。请保存下载文件，内容密钥另行保管，并定期进行离线恢复校验。' : '资料已导出。完整恢复请使用“完整备份”文件。';
        } catch(error) { status.textContent = error.message; } finally { button.disabled = false; }
      } else if (form.matches('form[action="/api/checkin"]')) {
        event.preventDefault(); const button=event.submitter; button.disabled=true;
        try {
          const response=await fetch(form.action,{method:'POST',body:new FormData(form)});
          if (!response.ok) throw new Error('签到失败，请重试。');
          const refreshed=await fetch('/admin',{method:'POST',body:new URLSearchParams({admin_token:token})});
          if (!refreshed.ok) throw new Error('签到已完成，状态刷新失败。');
          const doc=new DOMParser().parseFromString(await refreshed.text(),'text/html');
          for (const id of ['owner-status','operations-status','release-protection']) { const current=document.getElementById(id); const next=doc.getElementById(id); if(current&&next) current.replaceWith(next); }
          const readiness=doc.querySelector('.readiness'); if(readiness) document.querySelector('.readiness').replaceWith(readiness);
          window.aftermeBindFields(document);
          document.getElementById('checkin-feedback').textContent='签到成功，已更新状态。';
        } catch(error) { document.getElementById('checkin-feedback').textContent=error.message; } finally { button.disabled=false; }
      } else if (!event.defaultPrevented && !form.matches('[data-contact-form],[data-recipient-form],[data-private-item-form],[data-mail-template-form],.farewell-autosave,.farewell-command,.farewell-create-group,.farewell-create-entry')) {
        if (!token && form.querySelector('[name=admin_token]')) { event.preventDefault(); try { await unlock(); form.requestSubmit(event.submitter); } catch {} }
      }
    });
  })();`;
}
