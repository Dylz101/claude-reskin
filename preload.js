'use strict';

// Bridge for the app shell only. claude.ai panes get no preload at all.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'shell:ready', 'pane:layout', 'pane:focus', 'pane:close', 'pane:only', 'pane:back', 'pane:reload',
  'pane:split', 'chat:open', 'nav:go', 'ui:set', 'theme:set', 'theme:reset', 'update:check', 'update:restart'
]);
const INVOKE = new Set(['chats:list', 'fonts:list', 'fonts:add', 'fonts:remove']);
const LISTEN = new Set(['state', 'chats-changed']);

contextBridge.exposeInMainWorld('reskin', {
  send: (channel, data) => { if (SEND.has(channel)) ipcRenderer.send(channel, data); },
  invoke: (channel, data) => (INVOKE.has(channel) ? ipcRenderer.invoke(channel, data) : Promise.reject(new Error('blocked channel'))),
  on: (channel, fn) => {
    if (!LISTEN.has(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
