import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GLASS_THEME,
  GLASS_THEME_ID,
  REQUIRED_THEME_VARIABLES,
  renderGlassThemeCss,
} from '../src/lib/themes.mjs';

test('fixed glass laboratory theme exposes every required visual variable', () => {
  assert.equal(GLASS_THEME_ID, 'glass-laboratory');
  assert.equal(GLASS_THEME.id, GLASS_THEME_ID);
  assert.equal(GLASS_THEME.mode, 'light');
  assert.deepEqual(Object.keys(GLASS_THEME.variables).sort(), [...REQUIRED_THEME_VARIABLES].sort());
});

test('fixed glass CSS contains one root token block and no switching selectors', () => {
  const css = renderGlassThemeCss();
  assert.match(css, /^:root\{/);
  assert.match(css, /--panel-blur:0px/);
  assert.doesNotMatch(css, /data-theme-preview|clinical-blue|nature-editorial/);
});
