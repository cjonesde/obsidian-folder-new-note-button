'use strict';

const { Notice, Plugin, PluginSettingTab, Setting, Menu, normalizePath } = require('obsidian');

const DEFAULT_SETTINGS = Object.freeze({
  enableExcalidraw: false,
});

class FolderNewNoteButtonPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.explorerDisposers = new Map();
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new FolderNewNoteButtonSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.refreshFileExplorerHandlers());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshFileExplorerHandlers()));
  }

  onunload() {
    this.teardownAll();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isExcalidrawAvailable() {
    return this.app.plugins.enabledPlugins.has('obsidian-excalidraw-plugin');
  }

  getExcalidrawPlugin() {
    if (!this.isExcalidrawAvailable()) {
      return null;
    }
    return this.app.plugins.plugins['obsidian-excalidraw-plugin'] || null;
  }

  shouldShowMenu() {
    return this.settings.enableExcalidraw && this.isExcalidrawAvailable();
  }

  refreshFileExplorerHandlers() {
    const leaves = this.app.workspace.getLeavesOfType('file-explorer');
    const activeViews = new Set();

    for (const leaf of leaves) {
      const view = leaf.view;
      if (!view) {
        continue;
      }
      activeViews.add(view);
      if (!this.explorerDisposers.has(view)) {
        const disposer = this.setupExplorer(view);
        if (disposer) {
          this.explorerDisposers.set(view, disposer);
        }
      }
    }

    for (const [view, disposer] of Array.from(this.explorerDisposers.entries())) {
      if (!activeViews.has(view)) {
        disposer();
        this.explorerDisposers.delete(view);
      }
    }
  }

  setupExplorer(view) {
    const container = view.containerEl?.querySelector('.nav-files-container');
    if (!container) {
      return null;
    }

    const processFolders = () => this.decorateFolderTitles(container, view);
    processFolders();

    const observer = new MutationObserver(processFolders);
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      this.removeButtons(container);
    };
  }

  decorateFolderTitles(root, explorerView) {
    const folderTitles = root.querySelectorAll('.nav-folder-title');
    folderTitles.forEach((titleEl) => this.ensureButton(titleEl, explorerView));
  }

  ensureButton(folderTitleEl, explorerView) {
    if (folderTitleEl.querySelector('.folder-new-note-button')) {
      return;
    }

    const button = folderTitleEl.createEl('button', {
      cls: 'folder-new-note-button',
      attr: {
        type: 'button',
        'aria-label': 'Create new note in this folder'
      }
    });
    button.setText('+');

    this.registerDomEvent(button, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const folderPath = this.getFolderPath(folderTitleEl);
      if (!folderPath) {
        new Notice('Folder not found.');
        return;
      }
      const view = explorerView || this.findExplorerViewForElement(folderTitleEl);

      if (this.shouldShowMenu()) {
        this.showNewItemMenu(event, folderPath, view);
      } else {
        this.createNoteInFolder(folderPath, view);
      }
    });
  }

  getFolderPath(folderTitleEl) {
    const folderEl = folderTitleEl.closest('.nav-folder');
    const rawPath = folderEl?.dataset?.path ?? folderTitleEl.dataset?.path ?? '';
    const normalized = rawPath ? normalizePath(rawPath) : '';
    if (!folderEl) {
      return null;
    }

    const rootPath = this.app.vault.getRoot()?.path || '/';
    if (normalized === '' || normalized === '/') {
      return normalizePath(rootPath);
    }

    return normalized;
  }

  async createNoteInFolder(folderPath, explorerView) {
    const rootPath = normalizePath(this.app.vault.getRoot()?.path || '/');
    const folder = this.app.vault.getFolderByPath(folderPath)
      || (folderPath === rootPath ? this.app.vault.getRoot() : null);
    if (!folder) {
      new Notice('Folder not found.');
      return;
    }

    const fileName = this.generateUniqueFileName(folder);
    try {
      const file = await this.app.fileManager.createNewMarkdownFile(folder, fileName);
      const leaf = this.app.workspace.getLeaf(false);

      // Open the file and make it active
      await leaf.openFile(file);

      // Select the inline title (first line) in the editor
      this.selectInlineTitle(leaf);
    } catch (error) {
      console.error('Folder New Note Button: failed to create file', error);
      new Notice('Could not create note in this folder.');
    }
  }

  selectInlineTitle(leaf) {
    window.setTimeout(() => {
      const view = leaf.view;
      if (!view) {
        return;
      }

      const inlineTitleEl = view.containerEl?.querySelector('.inline-title');

      if (inlineTitleEl && inlineTitleEl.offsetParent !== null) {
        inlineTitleEl.focus();
        this.selectElementText(inlineTitleEl);
      } else {
        const headerTitleEl = view.containerEl?.querySelector('.view-header-title');
        if (headerTitleEl) {
          headerTitleEl.focus();

          if (headerTitleEl.tagName !== 'INPUT' && headerTitleEl.tagName !== 'TEXTAREA') {
            headerTitleEl.click();
          }

          window.setTimeout(() => {
            const activeEl = document.activeElement;
            if (activeEl && view.containerEl.contains(activeEl)) {
              this.selectElementText(activeEl);
            } else {
              this.selectElementText(headerTitleEl);
            }
          }, 50);
        }
      }
    }, 150);
  }

  selectElementText(element) {
    if (element.select) {
      element.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  generateUniqueFileName(folder) {
    const configured = this.getBaseFileName();
    const baseName = configured.endsWith('.md') ? configured.slice(0, -3) : configured;
    const extension = 'md';
    let attempt = 0;

    while (true) {
      const suffix = attempt === 0 ? '' : ` ${attempt}`;
      const candidate = `${baseName}${suffix}.${extension}`;
      const fullPath = normalizePath(`${folder.path}/${candidate}`);
      if (!this.app.vault.getAbstractFileByPath(fullPath)) {
        return candidate;
      }
      attempt += 1;
    }
  }

  getBaseFileName() {
    const configured = this.app.vault.getConfig?.('newFileName');
    if (typeof configured === 'string') {
      const trimmed = configured.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    return 'Untitled';
  }

  findExplorerViewForElement(element) {
    if (!element) {
      return null;
    }
    const leaf = this.app.workspace.getLeavesOfType('file-explorer')
      .find((candidate) => candidate.view?.containerEl?.contains(element));
    return leaf?.view ?? null;
  }

  showNewItemMenu(event, folderPath, explorerView) {
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle('New note')
        .setIcon('file-plus')
        .onClick(() => {
          this.createNoteInFolder(folderPath, explorerView);
        });
    });

    menu.addItem((item) => {
      item
        .setTitle('New Excalidraw drawing')
        .setIcon('pencil')
        .onClick(() => {
          this.createExcalidrawInFolder(folderPath);
        });
    });

    menu.showAtMouseEvent(event);
  }

  async createExcalidrawInFolder(folderPath) {
    const excalidrawPlugin = this.getExcalidrawPlugin();
    if (!excalidrawPlugin) {
      new Notice('Excalidraw plugin is not available.');
      return;
    }

    try {
      const filename = this.generateExcalidrawFilename(excalidrawPlugin.settings);
      const folderArg = (folderPath === '/' || folderPath === normalizePath('/')) ? '' : folderPath;
      await excalidrawPlugin.createAndOpenDrawing(filename, 'active-pane', folderArg);
    } catch (error) {
      console.error('Folder New Note Button: failed to create Excalidraw drawing', error);
      new Notice('Could not create Excalidraw drawing in this folder.');
    }
  }

  generateExcalidrawFilename(excalidrawSettings) {
    const prefix = excalidrawSettings?.drawingFilenamePrefix ?? 'Drawing ';
    const dateTimeFmt = excalidrawSettings?.drawingFilenameDateTime ?? '';
    const dateTime = dateTimeFmt && window.moment
      ? window.moment().format(dateTimeFmt)
      : '';

    let extension;
    if (excalidrawSettings?.compatibilityMode) {
      extension = '.excalidraw';
    } else if (excalidrawSettings?.useExcalidrawExtension) {
      extension = '.excalidraw.md';
    } else {
      extension = '.md';
    }

    return prefix + dateTime + extension;
  }

  removeButtons(container) {
    container.querySelectorAll('.folder-new-note-button').forEach((button) => button.remove());
  }

  teardownAll() {
    for (const disposer of this.explorerDisposers.values()) {
      disposer();
    }
    this.explorerDisposers.clear();
  }
}

class FolderNewNoteButtonSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const excalidrawAvailable = this.plugin.isExcalidrawAvailable();

    new Setting(containerEl)
      .setName('Excalidraw support')
      .setDesc(
        excalidrawAvailable
          ? 'When enabled, clicking + shows a menu to create a new note or a new Excalidraw drawing.'
          : 'Install and enable the Excalidraw plugin to use this feature.'
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableExcalidraw)
          .setDisabled(!excalidrawAvailable)
          .onChange(async (value) => {
            this.plugin.settings.enableExcalidraw = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

module.exports = FolderNewNoteButtonPlugin;
