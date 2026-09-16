// Presentation only: the engine computes changes and performs publication.
(() => {
  const button = document.getElementById('workingCopyBtn');
  const dialog = document.getElementById('workingCopyDialog');
  const list = document.getElementById('workingCopyFiles');
  const message = document.getElementById('workingCopyMessage');
  const apply = document.getElementById('workingCopyApply');
  let info = null;
  let invoker = null;
  function render(value) {
    info = value;
    list.replaceChildren();
    message.textContent = value.ok ?
      (value.busy ? 'The agent is working. Changes can be applied when the run stops.' :
        value.temporary ? `Working copy: ${value.root}\nApply selected changes to: ${value.workspace}` :
          `Editing files directly in ${value.root}`) : value.error;
    for (const change of value.changes || []) {
      const label = document.createElement('label');
      label.className = 'working-copy-file';
      const check = document.createElement('input');
      check.type = 'checkbox'; check.value = change.path;
      check.disabled = change.status === 'unsafe';
      const text = document.createElement('span');
      text.textContent = `${change.status}  ${change.path}`;
      label.append(check, text); list.appendChild(label);
    }
    if (value.ok && value.temporary && !value.busy && !value.changes.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No pending changes.'; list.appendChild(empty);
    }
    updateSelection();
  }
  function updateSelection() {
    apply.disabled = !info?.ok || info.busy || !list.querySelector('input:checked');
  }
  async function refresh() {
    try { render(await pywebview.api.working_copy_status()); }
    catch (error) { render({ok: false, error: String(error)}); }
  }
  button.addEventListener('click', () => {
    invoker = document.activeElement; dialog.showModal(); refresh();
  });
  list.addEventListener('change', updateSelection);
  document.getElementById('workingCopyRefresh').addEventListener('click', refresh);
  document.getElementById('workingCopyClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => invoker?.focus());
  apply.addEventListener('click', async () => {
    const paths = [...list.querySelectorAll('input:checked')].map(el => el.value);
    apply.disabled = true;
    try {
      const result = await pywebview.api.promote_changes(paths);
      if (result.ok) render(result.working_copy);
      else { message.textContent = result.error; updateSelection(); }
    } catch (error) { message.textContent = String(error); updateSelection(); }
  });
  const onEvent = window.__agent.onEvent.bind(window.__agent);
  window.__agent.onEvent = function (event) {
    onEvent(event);
    if (event.type === 'session_started') {
      button.textContent = event.working_copy?.temporary ? 'Working copy' : 'Workspace';
    }
    if (dialog.open && ['done', 'session_started', 'session_ended'].includes(event.type)) refresh();
  };
})();
