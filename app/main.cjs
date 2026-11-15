// Kindred desktop shell. Window/orb/shortcut/IPC pattern adapted from local_ai (Second Nature);
// all logic lives in core.mjs so it can be tested without Electron.
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, screen, dialog } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { statSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (hub && !hub.isDestroyed()) openHub('ask'); });

// kindred-capture looks for the Argmax key in the nearest .env above its working directory.
process.chdir(__dirname);
if (process.env.KINDRED_USER_DATA) app.setPath('userData', path.resolve(process.env.KINDRED_USER_DATA));

let hub, orb, chat, kindred, quitting = false;
let startError = null;

const windows = () => [hub, orb, chat].filter((w) => w && !w.isDestroyed());
const broadcast = (channel, payload) => { for (const w of windows()) w.webContents.send(channel, payload); };

const ORB_SIZE = { width: 112, height: 112 };
const CHAT_SIZE = { width: 560, height: 420 };
const ORB_MARGIN = 18;
function orbAnchor() {
  const { workArea } = screen.getPrimaryDisplay();
  return { centerX: Math.round(workArea.x + workArea.width / 2), bottom: workArea.y + workArea.height - ORB_MARGIN };
}
function placeOrb(width, height) {
  if (!orb || orb.isDestroyed()) return;
  const { centerX, bottom } = orbAnchor();
  const w = Math.max(ORB_SIZE.width, Math.min(720, Math.round(width)));
  const h = Math.max(ORB_SIZE.height, Math.min(420, Math.round(height)));
  orb.setBounds({ x: Math.round(centerX - w / 2), y: bottom - h, width: w, height: h });
}

function lockDown(win, pageFile) {
  const url = pathToFileURL(path.join(__dirname, pageFile)).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
}
const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true };

function createHub() {
  hub = new BrowserWindow({
    width: 1080, height: 780, minWidth: 720, minHeight: 560,
    title: 'Pebble', backgroundColor: '#F6F4EF', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 22 },
    webPreferences,
  });
  lockDown(hub, 'index.html');
  hub.once('ready-to-show', () => hub.show());
  hub.on('close', (event) => {
    // Closing the window keeps the orb alive so whispers still appear.
    if (!quitting && orb && !orb.isDestroyed()) { event.preventDefault(); hub.hide(); }
  });
  return hub.loadFile(path.join(__dirname, 'index.html'));
}

function createOrb() {
  const { centerX, bottom } = orbAnchor();
  orb = new BrowserWindow({
    x: centerX - ORB_SIZE.width / 2, y: bottom - ORB_SIZE.height, ...ORB_SIZE,
    title: 'Pebble', frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, focusable: true, backgroundColor: '#00000000', webPreferences,
  });
  orb.setAlwaysOnTop(true, 'floating');
  orb.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockDown(orb, 'orb.html');
  return orb.loadFile(path.join(__dirname, 'orb.html'));
}

function createChat() {
  const { centerX, bottom } = orbAnchor();
  chat = new BrowserWindow({
    x: centerX - CHAT_SIZE.width / 2, y: bottom - ORB_SIZE.height - CHAT_SIZE.height - 8,
    ...CHAT_SIZE, title: 'Pebble', frame: false, transparent: true,
    resizable: false, movable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, focusable: true, show: false, backgroundColor: '#00000000', webPreferences,
  });
  chat.setAlwaysOnTop(true, 'floating');
  chat.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockDown(chat, 'orb.html');
  return chat.loadFile(path.join(__dirname, 'orb.html'), { query: { chat: '1' } });
}

function openChat({ inactive = false } = {}) {
  if (!chat || chat.isDestroyed()) return;
  if (inactive) chat.showInactive();
  else { chat.show(); chat.focus(); }
  chat.webContents.send('chat:opened');
}

function openHub(view) {
  if (!hub || hub.isDestroyed()) return;
  if (hub.isMinimized()) hub.restore();
  hub.show(); hub.focus();
  if (view) hub.webContents.send('hub:navigate', view);
}

function need() { if (!kindred) throw new Error(startError || 'Kindred is still starting.'); return kindred; }
// IPC errors lose their class; keep a code so the renderer can show the "start memory" state.
const safe = (fn) => async (_event, ...args) => {
  try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
};

if (primary) app.whenReady().then(async () => {
  ipcMain.handle('kindred:status', () => kindred ? kindred.snapshot() : { starting: true, error: startError });
  ipcMain.handle('memory:check', safe(() => need().checkMemory()));
  ipcMain.handle('record:start', safe((opts) => need().startRecording(opts || {})));
  ipcMain.handle('record:stop', safe(() => need().stopRecording()));
  ipcMain.handle('record:cancel', safe(() => need().cancelRecording()));
  ipcMain.handle('voice:enroll', safe(() => need().enrollOwner()));
  ipcMain.handle('reply:start', safe(() => need().startReply()));
  ipcMain.handle('reply:stop', safe(() => need().stopReply()));
  ipcMain.handle('reply:cancel', safe(() => need().cancelReply()));
  ipcMain.handle('reply:language', safe((language) => need().setReplyLanguage(language)));
  ipcMain.handle('reply:typed', safe((text) => need().sendTypedReply(text)));
  ipcMain.handle('memory:people', safe(() => need().people()));
  ipcMain.handle('memory:memories', safe(() => need().memories()));
  ipcMain.handle('memory:inputs', safe(() => need().inputs()));
  ipcMain.handle('memory:traces', safe(() => need().traces()));
  ipcMain.handle('memory:layers', safe(() => need().layers()));
  ipcMain.handle('actions:list', safe(() => need().actionSuggestions()));
  ipcMain.handle('actions:scan', safe(() => need().scanActionSuggestions()));
  ipcMain.handle('actions:validate', safe((id, details) => need().validateActionSuggestion(id, details)));
  ipcMain.handle('actions:add', safe((id, details) => need().addActionSuggestion(id, details)));
  ipcMain.handle('actions:open-app', safe((target) => new Promise((resolve, reject) => {
    const name = { calendar: 'Calendar', reminders: 'Reminders', notes: 'Notes', contacts: 'Contacts' }[target];
    if (!name) return reject(new Error('Unknown Mac app.'));
    execFile('/usr/bin/open', ['-a', name], (error) => error ? reject(error) : resolve({ opened: name }));
  })));
  // One photo from this Mac into memory. The picker runs in the main process; the bytes never
  // leave the machine.
  ipcMain.handle('photos:add', safe(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(hub, {
      title: 'Add a photo to Pebble memory',
      buttonLabel: 'Save to memory',
      properties: ['openFile'],
      filters: [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'] }],
    });
    if (canceled || !filePaths?.length) return { cancelled: true };
    return need().addPhoto(filePaths[0]);
  }));
  // Attach a photo or text file to a question. The picker is native; the file never leaves this Mac.
  ipcMain.handle('files:pick', safe(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(hub, {
      title: 'Attach a photo or text file',
      buttonLabel: 'Attach',
      properties: ['openFile'],
      filters: [
        { name: 'Photos and text', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'txt', 'md', 'csv', 'json', 'log'] },
        { name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'] },
        { name: 'Text', extensions: ['txt', 'md', 'csv', 'json', 'log'] },
      ],
    });
    if (canceled || !filePaths?.length) return { cancelled: true };
    const file = filePaths[0];
    let size = 0;
    try { size = statSync(file).size; } catch { /* size is only a hint */ }
    return { path: file, name: path.basename(file), size };
  }));
  ipcMain.handle('ask:file', safe((question, file) => need().askWithFile(question, file)));
  ipcMain.handle('memory:dock', safe(() => need().dock()));
  ipcMain.handle('memory:ask', safe((q) => need().ask(q)));
  ipcMain.handle('ask:listen-start', safe(() => need().startAskListening()));
  ipcMain.handle('ask:listen-stop', safe(() => need().stopAskListening()));
  ipcMain.handle('intent:listen-start', safe(() => need().startAskListening({ intent: true })));
  ipcMain.handle('intent:listen-stop', safe(() => need().stopAskListening()));
  ipcMain.handle('voice:speak', safe((text) => need().speak(text)));
  ipcMain.handle('voice:stop', safe(() => need().stopSpeaking()));
  ipcMain.handle('hub:open', (_e, view) => { openHub(view); return true; });
  ipcMain.handle('orb:resize', (_e, width, height) => {
    if (Number.isFinite(width) && Number.isFinite(height)) placeOrb(width, height);
    return true;
  });
  ipcMain.handle('orb:menu', () => {
    if (!orb || orb.isDestroyed()) return false;   // no floating mark, no menu
    Menu.buildFromTemplate([
      { label: 'Open Pebble', click: () => openHub() },
      { label: 'Memory', click: () => openHub('memory') },
      { label: 'Ask', click: () => openHub('ask') },
      { type: 'separator' },
      { label: 'Hide pebble', click: () => orb?.hide() },
      { label: 'Quit Pebble', click: () => { quitting = true; app.quit(); } },
    ]).popup({ window: orb });
  });
  ipcMain.handle('chat:open', () => { openHub('ask'); return true; });
  ipcMain.handle('chat:close', () => { chat?.hide(); return true; });

  // The floating mark is switched off for now: Pebble lives in its own window only.
  // createOrb() / createChat() are kept for when it comes back, but nothing is placed on screen.
  await createHub();
  globalShortcut.register('CommandOrControl+Shift+K', () => openHub('ask'));
  try {
    const [core, bridge, live] = await Promise.all([
      import(pathToFileURL(path.join(__dirname, 'core.mjs')).href),
      import(pathToFileURL(path.join(__dirname, '../capture/bridge.mjs')).href),
      import(pathToFileURL(path.join(__dirname, '../capture/live.mjs')).href),
    ]);
    kindred = new core.KindredApp({
      CaptureBridge: bridge.CaptureBridge,
      LiveWhisper: live.LiveWhisper,
      repoRoot: path.resolve(__dirname, '..'),
      superviseMemory: process.env.KINDRED_SUPERVISE_MEMORY !== '0', // start/restart memory/src/server.mjs
      emit: (type, payload) => {
        if (type === 'log') { console.log(`[capture] ${payload}`); return; }
        broadcast(`kindred:${type}`, payload);
        if (type === 'whisper' && chat) openChat({ inactive: true });
      },
    });
    await kindred.start();
    // Re-check memory now and then so the banner clears once the server is started.
    setInterval(() => kindred.checkMemory(), 5000).unref?.();
  } catch (error) {
    startError = `Kindred could not start: ${error.message}`;
    console.error(startError);
    broadcast('kindred:status', { starting: false, error: startError });
  }
  app.on('activate', () => openHub());
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); kindred?.close(); });
app.on('window-all-closed', () => app.quit());
