const { contextBridge, ipcRenderer } = require('electron');
const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, payload) => callback(payload));
contextBridge.exposeInMainWorld('kindred', {
  status: () => ipcRenderer.invoke('kindred:status'),
  checkMemory: () => ipcRenderer.invoke('memory:check'),
  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  cancelRecording: () => ipcRenderer.invoke('record:cancel'),
  enrollOwner: () => ipcRenderer.invoke('voice:enroll'),
  people: () => ipcRenderer.invoke('memory:people'),
  dock: () => ipcRenderer.invoke('memory:dock'),
  ask: (question) => ipcRenderer.invoke('memory:ask', question),
  speak: (text) => ipcRenderer.invoke('voice:speak', text),
  stopSpeaking: () => ipcRenderer.invoke('voice:stop'),
  openHub: (view) => ipcRenderer.invoke('hub:open', view),
  resizeOrb: (width, height) => ipcRenderer.invoke('orb:resize', width, height),
  orbMenu: () => ipcRenderer.invoke('orb:menu'),
  onStatus: on('kindred:status'),
  onWhisper: on('kindred:whisper'),
  onRecordingDone: on('kindred:recording-done'),
  onEnrollDone: on('kindred:enroll-done'),
  onSpeaking: on('kindred:speaking'),
  onNavigate: on('hub:navigate'),
});
