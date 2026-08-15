export const DEFAULT_THEME_ID = 'clinical-blue';
export const THEME_STORAGE_KEY = 'prime-design-theme';

export const REQUIRED_THEME_VARIABLES = Object.freeze([
  'font-body', 'font-heading', 'font-mono', 'page-bg', 'surface', 'surface-strong',
  'text', 'muted', 'border', 'primary', 'primary-hover', 'primary-contrast',
  'header-bg', 'header-text', 'header-muted', 'badge-bg', 'input-bg', 'table-head',
  'success', 'danger', 'warning', 'shadow', 'radius', 'panel-blur', 'table-pad',
]);

function theme(id, name, description, mode, swatches, variables) {
  return Object.freeze({ id, name, description, mode, swatches: Object.freeze(swatches), variables: Object.freeze(variables) });
}

export const THEMES = Object.freeze([
  theme('clinical-blue', '临床蓝', '专业蓝白与清晰卡片，适合日常实验工作。', 'light', ['#0d6ca8', '#ffffff', '#eef5fa'], {
    'font-body': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-heading': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-mono': 'Consolas, monospace',
    'page-bg': '#f2f5f8', surface: '#ffffff', 'surface-strong': '#f8fbfd', text: '#18222d', muted: '#5b6875', border: '#d8e1e8',
    primary: '#0d6ca8', 'primary-hover': '#095887', 'primary-contrast': '#ffffff', 'header-bg': 'linear-gradient(135deg,#123b5c,#185d89)',
    'header-text': '#ffffff', 'header-muted': '#cbd9e5', 'badge-bg': '#315b7d', 'input-bg': '#ffffff', 'table-head': '#edf3f7',
    success: '#18753c', danger: '#a22a2a', warning: '#9b6500', shadow: '0 5px 18px #17324d14', radius: '10px', 'panel-blur': '0px', 'table-pad': '8px',
  }),
  theme('nature-editorial', 'Nature 编辑风', '象牙纸色、深绿与衬线标题，接近期刊版式。', 'light', ['#254f3d', '#f7f2e7', '#c7aa72'], {
    'font-body': 'Georgia, "Microsoft YaHei", serif', 'font-heading': 'Georgia, "Songti SC", serif', 'font-mono': 'Consolas, monospace',
    'page-bg': '#eee9dc', surface: '#fbf8f0', 'surface-strong': '#f4efe3', text: '#242820', muted: '#687064', border: '#d7ceb9',
    primary: '#254f3d', 'primary-hover': '#173d2d', 'primary-contrast': '#ffffff', 'header-bg': 'linear-gradient(100deg,#173b2c,#315c45)',
    'header-text': '#fffdf6', 'header-muted': '#d9e1d5', 'badge-bg': '#496b57', 'input-bg': '#fffdf7', 'table-head': '#ece5d5',
    success: '#2f6b43', danger: '#983b33', warning: '#8c650f', shadow: '0 4px 16px #4f493517', radius: '3px', 'panel-blur': '0px', 'table-pad': '9px',
  }),
  theme('genomics-aurora', '基因组极光', '青绿到紫色渐变，呈现现代生物科技感。', 'light', ['#0b8f86', '#6750c9', '#eafaf8'], {
    'font-body': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-heading': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-mono': 'Cascadia Mono, Consolas, monospace',
    'page-bg': 'linear-gradient(145deg,#ecfbf8 0%,#f1efff 55%,#e8f4ff 100%)', surface: '#ffffffdc', 'surface-strong': '#f7fffeea', text: '#162c35', muted: '#5f6c79', border: '#c9dedf',
    primary: '#0b8f86', 'primary-hover': '#08736d', 'primary-contrast': '#ffffff', 'header-bg': 'linear-gradient(110deg,#067c76,#6750c9 72%,#844cc2)',
    'header-text': '#ffffff', 'header-muted': '#e0fbf7', 'badge-bg': '#ffffff2b', 'input-bg': '#ffffffdd', 'table-head': '#e6f5f5',
    success: '#11805a', danger: '#b23561', warning: '#a96a00', shadow: '0 10px 30px #3f6c8d1e', radius: '16px', 'panel-blur': '12px', 'table-pad': '9px',
  }),
  theme('swiss-scientific', '瑞士科学', '黑白红、高对比和方正网格，强调信息秩序。', 'light', ['#e1251b', '#ffffff', '#111111'], {
    'font-body': 'Arial, "Microsoft YaHei", sans-serif', 'font-heading': 'Arial Black, Arial, sans-serif', 'font-mono': 'Consolas, monospace',
    'page-bg': '#f4f4f2', surface: '#ffffff', 'surface-strong': '#ffffff', text: '#111111', muted: '#555555', border: '#111111',
    primary: '#e1251b', 'primary-hover': '#b91710', 'primary-contrast': '#ffffff', 'header-bg': '#ffffff',
    'header-text': '#111111', 'header-muted': '#555555', 'badge-bg': '#111111', 'input-bg': '#ffffff', 'table-head': '#efefec',
    success: '#16713b', danger: '#c31f18', warning: '#855d00', shadow: '4px 4px 0 #111111', radius: '0px', 'panel-blur': '0px', 'table-pad': '7px',
  }),
  theme('dark-laboratory', '深色实验室', '深蓝黑背景与青色强调，适合夜间使用。', 'dark', ['#41c7d6', '#111923', '#1d2a36'], {
    'font-body': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-heading': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-mono': 'Cascadia Mono, Consolas, monospace',
    'page-bg': '#0d141d', surface: '#151f2a', 'surface-strong': '#1b2835', text: '#e7f0f6', muted: '#9fb0bd', border: '#304252',
    primary: '#41c7d6', 'primary-hover': '#68d9e4', 'primary-contrast': '#071217', 'header-bg': 'linear-gradient(120deg,#0a1119,#142b3a)',
    'header-text': '#f0fbff', 'header-muted': '#9dc0cb', 'badge-bg': '#1d4653', 'input-bg': '#101923', 'table-head': '#1d2c39',
    success: '#57d08a', danger: '#ff7b83', warning: '#f1c56d', shadow: '0 8px 24px #00000055', radius: '9px', 'panel-blur': '0px', 'table-pad': '8px',
  }),
  theme('glass-laboratory', '玻璃实验室', '半透明面板与柔和渐变，兼顾清晰度和流畅度。', 'light', ['#3888d8', '#f7fbff', '#d8e8ff'], {
    'font-body': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-heading': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-mono': 'Cascadia Mono, Consolas, monospace',
    'page-bg': 'radial-gradient(circle at 12% 10%,#d5f0ff 0,transparent 35%),radial-gradient(circle at 88% 24%,#eadcff 0,transparent 38%),#eef4fb', surface: '#ffffffa8', 'surface-strong': '#ffffffc7', text: '#193149', muted: '#607488', border: '#ffffffc9',
    primary: '#287fc4', 'primary-hover': '#1769a8', 'primary-contrast': '#ffffff', 'header-bg': 'linear-gradient(110deg,#236da7cc,#6e55b8cc)',
    'header-text': '#ffffff', 'header-muted': '#e7f5ff', 'badge-bg': '#ffffff2e', 'input-bg': '#ffffffb8', 'table-head': '#e8f1f8c7',
    success: '#16865a', danger: '#b23a5a', warning: '#9d6700', shadow: '0 10px 28px #355b8520', radius: '18px', 'panel-blur': '0px', 'table-pad': '9px',
  }),
  theme('minimal-ink', '极简墨色', '纯黑白灰和弱阴影，让实验内容成为焦点。', 'light', ['#111111', '#ffffff', '#dedede'], {
    'font-body': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-heading': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-mono': 'Consolas, monospace',
    'page-bg': '#f7f7f7', surface: '#ffffff', 'surface-strong': '#fafafa', text: '#111111', muted: '#666666', border: '#d1d1d1',
    primary: '#111111', 'primary-hover': '#333333', 'primary-contrast': '#ffffff', 'header-bg': '#111111',
    'header-text': '#ffffff', 'header-muted': '#cfcfcf', 'badge-bg': '#333333', 'input-bg': '#ffffff', 'table-head': '#f0f0f0',
    success: '#287047', danger: '#a72e2e', warning: '#806000', shadow: '0 1px 5px #00000012', radius: '5px', 'panel-blur': '0px', 'table-pad': '8px',
  }),
  theme('soft-biology', '柔和生物', '鼠尾草绿、淡紫和圆润界面，视觉更轻松。', 'light', ['#6d8d74', '#f5f1fa', '#d9cfea'], {
    'font-body': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-heading': 'Segoe UI, "Microsoft YaHei", sans-serif', 'font-mono': 'Consolas, monospace',
    'page-bg': 'linear-gradient(150deg,#edf4ee,#f5f1fa)', surface: '#fffefd', 'surface-strong': '#f7faf6', text: '#2e3931', muted: '#6f786f', border: '#d8dfd5',
    primary: '#607f68', 'primary-hover': '#4b6853', 'primary-contrast': '#ffffff', 'header-bg': 'linear-gradient(110deg,#607f68,#8876a1)',
    'header-text': '#ffffff', 'header-muted': '#edf5ed', 'badge-bg': '#ffffff29', 'input-bg': '#fffefd', 'table-head': '#edf2ea',
    success: '#4b7f5b', danger: '#a54f62', warning: '#9a7224', shadow: '0 7px 22px #655b7818', radius: '20px', 'panel-blur': '0px', 'table-pad': '10px',
  }),
  theme('data-console', '数据终端', '深色等宽字体与绿色状态提示，像分析工作站。', 'dark', ['#45e07b', '#07110b', '#122019'], {
    'font-body': 'Cascadia Mono, Consolas, monospace', 'font-heading': 'Cascadia Mono, Consolas, monospace', 'font-mono': 'Cascadia Mono, Consolas, monospace',
    'page-bg': '#050b07', surface: '#0b1510', 'surface-strong': '#101e16', text: '#c9f5d5', muted: '#7eaa8b', border: '#244b31',
    primary: '#45e07b', 'primary-hover': '#75ef9d', 'primary-contrast': '#041108', 'header-bg': '#07110b',
    'header-text': '#76f39e', 'header-muted': '#79aa87', 'badge-bg': '#12351f', 'input-bg': '#07110b', 'table-head': '#11271a',
    success: '#45e07b', danger: '#ff6b74', warning: '#e5c451', shadow: '0 0 0 1px #1c4529,0 0 22px #20d5640e', radius: '2px', 'panel-blur': '0px', 'table-pad': '7px',
  }),
  theme('warm-paper', '暖色纸张', '米黄、琥珀和棕色，接近实验记录本。', 'light', ['#a35d20', '#f6eddc', '#d5b77c'], {
    'font-body': 'Georgia, "Microsoft YaHei", serif', 'font-heading': 'Georgia, "Songti SC", serif', 'font-mono': 'Consolas, monospace',
    'page-bg': '#eee1c9', surface: '#fbf4e6', 'surface-strong': '#f6ead6', text: '#392c20', muted: '#756554', border: '#d8c3a2',
    primary: '#9a541c', 'primary-hover': '#783e13', 'primary-contrast': '#fffaf1', 'header-bg': 'linear-gradient(105deg,#6e3e1d,#a4672d)',
    'header-text': '#fff8e9', 'header-muted': '#ead8bc', 'badge-bg': '#875329', 'input-bg': '#fffaf0', 'table-head': '#efe0c7',
    success: '#4e7544', danger: '#a74335', warning: '#98640d', shadow: '0 5px 16px #5f3b1f20', radius: '7px', 'panel-blur': '0px', 'table-pad': '9px',
  }),
]);

export function validateThemes(themes = THEMES) {
  if (!Array.isArray(themes) || themes.length !== 10) throw new Error('主题注册表必须恰好包含 10 个主题。');
  const ids = new Set();
  for (const item of themes) {
    if (!/^[a-z][a-z0-9-]+$/.test(item.id) || ids.has(item.id)) throw new Error(`主题 ID 无效或重复：${item.id}`);
    ids.add(item.id);
    if (!['light', 'dark'].includes(item.mode)) throw new Error(`主题 ${item.id} 的 mode 无效。`);
    if (!item.name || !item.description || !Array.isArray(item.swatches) || item.swatches.length !== 3) throw new Error(`主题 ${item.id} 的元数据不完整。`);
    const missing = REQUIRED_THEME_VARIABLES.filter((key) => !item.variables[key]);
    if (missing.length) throw new Error(`主题 ${item.id} 缺少变量：${missing.join(', ')}。`);
  }
  if (!ids.has(DEFAULT_THEME_ID)) throw new Error('默认主题未注册。');
  return themes;
}

validateThemes();

export function normalizeThemeId(value) {
  const id = String(value || '');
  return THEMES.some((item) => item.id === id) ? id : DEFAULT_THEME_ID;
}

export function themeMetadata() {
  return THEMES.map(({ id, name, description, mode, swatches }) => ({ id, name, description, mode, swatches: [...swatches] }));
}

export function renderThemeCss() {
  const blocks = THEMES.map((item) => {
    const declarations = Object.entries(item.variables).map(([key, value]) => `--${key}:${value}`).join(';');
    const preview = `--preview-bg:${item.variables['page-bg']};--preview-surface:${item.variables.surface};--preview-border:${item.variables.border};--preview-primary:${item.variables['header-bg']}`;
    return `:root[data-theme="${item.id}"]{color-scheme:${item.mode};${declarations}}\n[data-theme-preview="${item.id}"]{color-scheme:${item.mode};${declarations};${preview}}`;
  });
  return `${blocks.join('\n')}\n`;
}

export const GLASS_THEME_ID = 'glass-laboratory';
export const GLASS_THEME = THEMES.find((item) => item.id === GLASS_THEME_ID);

export function renderGlassThemeCss(selector = ':root') {
  const declarations = Object.entries(GLASS_THEME.variables)
    .map(([key, value]) => `--${key}:${value}`)
    .join(';');
  return `${selector}{color-scheme:${GLASS_THEME.mode};${declarations}}\n`;
}
