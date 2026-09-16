// Offline UI fixture. This does not call the agent, providers, or filesystem.
const previewCopy = {ok: true, temporary: true, root: '/tmp/omni-agent-work-preview',
  workspace: '/projects/example', busy: false,
  changes: [{path: 'src/app.py', status: 'modified'}, {path: 'notes.md', status: 'added'}]};
window.pywebview = {api: new Proxy({
  get_projects: async () => ({ok:true, recent:[{label:'Example project', path:'/projects/example', message_count:2}], last:'/projects/example'}),
  get_state: async () => ({active:false}),
  get_model_options: async () => ({ok:true, options:[]}),
  list_devices: async () => ({ok:true, devices:[]}),
  working_copy_status: async () => previewCopy,
  promote_changes: async paths => {
    previewCopy.changes = previewCopy.changes.filter(change => !paths.includes(change.path));
    return {ok:true, working_copy:previewCopy};
  },
  start_session: async () => {
    setTimeout(() => {
      const emit = event => window.__agent.onEvent(event);
      emit({type:'session_started', project:'Example project', file_tree:{children:[{name:'src', path:'src', type:'dir', children:[]}]},
        busy:false, working_copy:previewCopy, transcript:[
          {type:'user_message', content:'Review the app and prepare the changes in a working copy.'},
          {type:'final_answer', time:'01:32', steps:3, content:'The app now uses a shared engine for the desktop and terminal. You can review the changed files before applying them to your workspace.'}
        ]});
      emit({type:'wave_started', wave_id:'preview', size:1, workers:1});
      emit({type:'subagent_started', sub_id:'preview-worker', agent:'engineer', task:'Check the shared engine startup and tool routing.', model:'configured model'});
      emit({type:'subagent_chat', sub_id:'preview-worker', agent:'engineer', role:'assistant', content:'I found the engine entry point. I’m checking that the terminal and desktop use the same session.'});
      emit({type:'subagent_chat', sub_id:'preview-worker', agent:'engineer', role:'tool_call', tool:'run_command', content:'python -m pytest tests/test_headless_engine.py -q'});
      emit({type:'subagent_chat', sub_id:'preview-worker', agent:'engineer', role:'tool_result', tool:'run_command', content:'7 tests passed.'});
      emit({type:'subagent_done', sub_id:'preview-worker', agent:'engineer', ok:true, tokens:1240, steps:3, elapsed_s:8});
      emit({type:'wave_done', wave_id:'preview'});
    }, 20);
    return {ok:true};
  }
}, {get:(target, name) => target[name] || (async () => ({ok:true}))})};
