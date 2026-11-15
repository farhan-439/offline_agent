// Kindred desktop shell. Window/orb/shortcut/IPC pattern adapted from local_ai (Second Nature);
// all logic lives in core.mjs so it can be tested without Electron.
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// kindred-capture looks for the Argmax key in the nearest .env above its working directory.
process.chdir(__dirname);
if (process.env.KINDRED_USER_DATA) app.setPath('userData', path.resolve(process.env.KINDRED_USER_DATA));

let hub, orb, kindred, quitting = false;
let startError = null;

const windows = () => [hub, orb].filter((w) => w && !w.isDestroyed());
const broadcast = (channel, payload) => { for (const w of windows()) w.webContents.send(channel, payload); };

const ORB_SIZE = { width: 96, height: 96 };
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
    width: 1120, height: 820, minWidth: 760, minHeight: 600,
    title: 'Kindred', backgroundColor: '#f7f5f1', show: false,
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
    title: 'Kindred Orb', frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, focusable: true, backgroundColor: '#00000000', webPreferences,
  });
  orb.setAlwaysOnTop(true, 'floating');
  orb.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockDown(orb, 'orb.html');
  return orb.loadFile(path.join(__dirname, 'orb.html'));
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

app.whenReady().then(async () => {
  ipcMain.handle('kindred:status', () => kindred ? kindred.snapshot() : { starting: true, error: startError });
  ipcMain.handle('memory:check', safe(() => need().checkMemory()));
  ipcMain.handle('record:start', safe((opts) => need().startRecording(opts || {})));
  ipcMain.handle('record:stop', safe(() => need().stopRecording()));
  ipcMain.handle('record:cancel', safe(() => need().cancelRecording()));
  ipcMain.handle('voice:enroll', safe(() => need().enrollOwner()));
  ipcMain.handle('memory:people', safe(() => need().people()));
  ipcMain.handle('memory:dock', safe(() => need().dock()));
  ipcMain.handle('memory:ask', safe((q) => need().ask(q)));
  ipcMain.handle('voice:speak', safe((text) => need().speak(text)));
  ipcMain.handle('voice:stop', safe(() => need().stopSpeaking()));
  ipcMain.handle('hub:open', (_e, view) => { openHub(view); return true; });
  ipcMain.handle('orb:resize', (_e, width, height) => {
    if (Number.isFinite(width) && Number.isFinite(height)) placeOrb(width, height);
    return true;
  });
  ipcMain.handle('orb:menu', () => {
    Menu.buildFromTemplate([
      { label: 'Open Kindred', click: () => openHub() },
      { label: 'People', click: () => openHub('people') },
      { label: 'Ask', click: () => openHub('ask') },
      { type: 'separator' },
      { label: 'Hide orb', click: () => orb?.hide() },
      { label: 'Quit Kindred', click: () => { quitting = true; app.quit(); } },
    ]).popup({ window: orb });
  });

  await Promise.all([createHub(), createOrb()]);
  globalShortcut.register('CommandOrControl+Shift+K', () => openHub('record'));
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
      emit: (type, payload) => {
        if (type === 'log') { console.log(`[capture] ${payload}`); return; }
        broadcast(`kindred:${type}`, payload);
        if (type === 'whisper' && orb && !orb.isDestroyed()) orb.showInactive();
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
