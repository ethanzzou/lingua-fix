const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linguafix', {
  getConfig: () => ipcRenderer.invoke('linguafix:get-config'),
  getHistory: (query) => ipcRenderer.invoke('linguafix:get-history', query),
  deleteHistoryRecord: (id) => ipcRenderer.invoke('linguafix:delete-history-record', id),
  setHistoryRecordBookmark: (id, isBookmarked) =>
    ipcRenderer.invoke('linguafix:set-history-record-bookmark', id, isBookmarked),
  updateHistoryRecordTags: (id, tags) =>
    ipcRenderer.invoke('linguafix:update-history-record-tags', id, tags),
  clearHistory: () => ipcRenderer.invoke('linguafix:clear-history'),
  saveConfig: (config) => ipcRenderer.invoke('linguafix:save-config', config),
  processText: (request) => ipcRenderer.invoke('linguafix:process-text', request),
  hidePopup: () => ipcRenderer.invoke('linguafix:hide-popup'),
  onPopupSession: (callback) => {
    const listener = (_event, session) => callback(session);
    ipcRenderer.on('linguafix:popup-session', listener);
    return () => {
      ipcRenderer.removeListener('linguafix:popup-session', listener);
    };
  },
  onShowQuickTranslateOverlay: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('linguafix:show-quick-translate-overlay', listener);
    return () => {
      ipcRenderer.removeListener('linguafix:show-quick-translate-overlay', listener);
    };
  },
});
