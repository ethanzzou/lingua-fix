const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linguafix', {
  getConfig: () => ipcRenderer.invoke('linguafix:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('linguafix:save-config', config),
  processText: (request) => ipcRenderer.invoke('linguafix:process-text', request),
  hidePopup: () => ipcRenderer.invoke('linguafix:hide-popup'),
  onShowQuickTranslateOverlay: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('linguafix:show-quick-translate-overlay', listener);
    return () => {
      ipcRenderer.removeListener('linguafix:show-quick-translate-overlay', listener);
    };
  },
});
