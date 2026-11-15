// Kindred desktop shell. Window/orb/shortcut/IPC pattern adapted from local_ai (Second Nature);
// all logic lives in core.mjs so it can be tested without Electron.
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (hub && !hub.isDestroyed()) openHub('chat'); });

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
  ipcMain.handle('memory:people', safe(() => need().people()));
  ipcMain.handle('memory:memories', safe(() => need().memories()));
  ipcMain.handle('memory:inputs', safe(() => need().inputs()));
  ipcMain.handle('memory:traces', safe(() => need().traces()));
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
    Menu.buildFromTemplate([
      { label: 'Open Pebble', click: () => openHub() },
      { label: 'People', click: () => openHub('people') },
      { label: 'Chat', click: () => openHub('chat') },
      { type: 'separator' },
      { label: 'Hide pebble', click: () => orb?.hide() },
      { label: 'Quit Pebble', click: () => { quitting = true; app.quit(); } },
    ]).popup({ window: orb });
  });
  ipcMain.handle('chat:open', () => { openChat(); return true; });
  ipcMain.handle('chat:close', () => { chat?.hide(); return true; });

  await Promise.all([createHub(), createOrb(), createChat()]);
  globalShortcut.register('CommandOrControl+Shift+K', () => openHub('chat'));
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
        if (type === 'whisper') openChat({ inactive: true });
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
