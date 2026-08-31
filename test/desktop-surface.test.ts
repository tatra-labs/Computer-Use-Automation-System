import { describe, expect, it } from 'vitest';
import { UiaElement, UiaSurface, controlFromUiaElement, mapUiaControlType } from '../src/surface/desktop/uia-surface.js';
import { SurfaceError } from '../src/surface/surface.js';
import { resolveTarget } from '../src/core/resolve.js';
import { Observation, zTargetDescriptor } from '../src/core/target.js';

/** Descriptors go through the schema so defaults (minScore/minMargin) match replay. */
const target = (d: unknown) => zTargetDescriptor.parse(d);

const el = (over: Partial<UiaElement> = {}): UiaElement => ({
  controlType: 'Edit',
  name: '',
  automationId: '',
  className: '',
  isEnabled: true,
  boundingRectangle: { left: 10, top: 20, right: 110, bottom: 44 },
  ancestors: [],
  ...over,
});

describe('mapUiaControlType', () => {
  it('maps the interactive control types onto concrete roles', () => {
    expect(mapUiaControlType('Button')).toBe('button');
    expect(mapUiaControlType('SplitButton')).toBe('button');
    expect(mapUiaControlType('Hyperlink')).toBe('link');
    expect(mapUiaControlType('Edit')).toBe('textbox');
    expect(mapUiaControlType('Document')).toBe('textbox');
    expect(mapUiaControlType('ComboBox')).toBe('combobox');
    expect(mapUiaControlType('CheckBox')).toBe('checkbox');
    expect(mapUiaControlType('RadioButton')).toBe('radio');
    expect(mapUiaControlType('MenuItem')).toBe('menuitem');
    expect(mapUiaControlType('TabItem')).toBe('tab');
    expect(mapUiaControlType('ListItem')).toBe('option');
    expect(mapUiaControlType('TreeItem')).toBe('option');
  });

  it('maps grid, text and window types the way the resolver can use them', () => {
    expect(mapUiaControlType('DataItem')).toBe('cell');
    expect(mapUiaControlType('HeaderItem')).toBe('columnheader');
    expect(mapUiaControlType('Text')).toBe('text');
    expect(mapUiaControlType('Image')).toBe('image');
    expect(mapUiaControlType('Window')).toBe('dialog');
  });

  it('sends containers and unrecognized types to unknown rather than a wrong concrete role', () => {
    for (const t of ['Custom', 'Pane', 'Group', 'Table', 'DataGrid', 'List', 'Tree', 'Tab', 'ToolBar', 'Slider', 'Calendar', 'Separator', '', '   ']) {
      expect(mapUiaControlType(t)).toBe('unknown');
    }
    expect(mapUiaControlType('DirectUIHWND')).toBe('unknown');
  });

  it('accepts the spellings the different UIA bindings emit', () => {
    expect(mapUiaControlType('UIA_ButtonControlTypeId')).toBe('button');
    expect(mapUiaControlType('ControlType.CheckBox')).toBe('checkbox');
    expect(mapUiaControlType('ControlType_RadioButton')).toBe('radio');
    expect(mapUiaControlType('  hyperlink  ')).toBe('link');
    expect(mapUiaControlType('COMBOBOX')).toBe('combobox');
  });
});

describe('controlFromUiaElement', () => {
  it('maps geometry, ref, frame, value and enabled state', () => {
    const c = controlFromUiaElement(
      el({
        controlType: 'Edit',
        name: 'Member Number',
        value: ' 88214 ',
        isEnabled: false,
        boundingRectangle: { left: 100, top: 200, right: 340, bottom: 224 },
      }),
      ['MAIN', 'MDI:Posting'],
      7,
    );
    expect(c.ref).toBe('u7');
    expect(c.role).toBe('textbox');
    expect(c.name).toBe('Member Number');
    expect(c.value).toBe('88214');
    expect(c.enabled).toBe(false);
    expect(c.frame).toEqual(['MAIN', 'MDI:Posting']);
    expect(c.bbox).toEqual({ x: 100, y: 200, w: 240, h: 24 });
  });

  it('leaves ordinal at 0 for the caller to assign', () => {
    expect(controlFromUiaElement(el({ name: 'Post' }), [], 0).ordinal).toBe(0);
    expect(controlFromUiaElement(el({ name: 'Post' }), [], 3).ordinal).toBe(0);
  });

  it('clamps inverted and zeroed rectangles instead of emitting negative sizes', () => {
    const c = controlFromUiaElement(el({ boundingRectangle: { left: 0, top: 0, right: -1, bottom: -1 } }), [], 0);
    expect(c.bbox).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('rounds fractional rects (per-monitor DPI scaling)', () => {
    const c = controlFromUiaElement(el({ boundingRectangle: { left: 10.4, top: 20.6, right: 110.4, bottom: 44.6 } }), [], 0);
    expect(c.bbox).toEqual({ x: 10, y: 21, w: 100, h: 24 });
  });

  it('builds labels from name, help text and the nearest label-ish ancestor', () => {
    const c = controlFromUiaElement(
      el({
        name: 'Amount',
        helpText: 'Posting amount in account currency',
        ancestors: [
          { controlType: 'Text', name: 'AMT PAID:' },
          { controlType: 'Text', name: 'IGNORED — only the nearest is taken' },
          { controlType: 'Group', name: 'Transaction Detail' },
        ],
      }),
      [],
      0,
    );
    expect(c.labels).toEqual(['Amount', 'Posting amount in account currency', 'AMT PAID:']);
  });

  it('is the legacy case: no accessible name, so the caption ancestor is the only locator', () => {
    const c = controlFromUiaElement(
      el({
        controlType: 'Edit',
        name: '',
        helpText: '',
        ancestors: [
          { controlType: 'Custom', name: '' },
          { controlType: 'HeaderItem', name: 'MBR NO' },
          { controlType: 'Table', name: 'Members' },
        ],
      }),
      [],
      0,
    );
    expect(c.name).toBe('');
    expect(c.labels).toEqual(['MBR NO']);
  });

  it('drops empty and whitespace-only captions and collapses whitespace', () => {
    const c = controlFromUiaElement(
      el({ name: '  Post \n Batch ', helpText: '   ', ancestors: [{ controlType: 'Text', name: '' }] }),
      [],
      0,
    );
    expect(c.name).toBe('Post Batch');
    expect(c.labels).toEqual(['Post Batch']);
  });

  it('deduplicates captions that differ only in case, spacing or trailing punctuation', () => {
    const c = controlFromUiaElement(
      el({ name: 'Member Number', helpText: 'member  number:', ancestors: [{ controlType: 'Text', name: 'MEMBER NUMBER' }] }),
      [],
      0,
    );
    expect(c.labels).toEqual(['Member Number']);
  });

  it('takes container captions outermost-first from container-ish ancestors only', () => {
    const c = controlFromUiaElement(
      el({
        ancestors: [
          { controlType: 'Text', name: 'AMOUNT:' },
          { controlType: 'Group', name: 'Transaction Detail' },
          { controlType: 'Custom', name: 'grid host' },
          { controlType: 'Pane', name: 'Posting' },
          { controlType: 'Window', name: 'Riverbend Back Office' },
        ],
      }),
      [],
      0,
    );
    expect(c.container).toEqual(['Riverbend Back Office', 'Posting', 'Transaction Detail']);
  });

  it('caps deep pane chains, keeping the window title and the innermost groups', () => {
    const ancestors = [
      { controlType: 'Group', name: 'G1' },
      { controlType: 'Pane', name: 'P4' },
      { controlType: 'Pane', name: 'P3' },
      { controlType: 'Pane', name: 'P2' },
      { controlType: 'Pane', name: 'P1' },
      { controlType: 'Window', name: 'W' },
    ];
    const c = controlFromUiaElement(el({ ancestors }), [], 0);
    expect(c.container).toEqual(['W', 'P3', 'P4', 'G1']);
  });

  it('quarantines automationId and className as low-weight hints', () => {
    const c = controlFromUiaElement(el({ automationId: 'txtMbrNo_18294', className: 'WindowsForms10.EDIT.app.0.141b42a_r9_ad1' }), [], 0);
    expect(c.hint).toEqual({ attrName: 'txtMbrNo_18294', tag: 'WindowsForms10.EDIT.app.0.141b42a_r9_ad1' });
  });

  it('omits hint fields the provider left blank', () => {
    expect(controlFromUiaElement(el(), [], 0).hint).toEqual({ tag: undefined, attrName: undefined });
  });

  it('produces controls the existing resolver can address with no schema change', () => {
    const controls = [
      controlFromUiaElement(
        el({ controlType: 'Edit', name: '', ancestors: [{ controlType: 'Text', name: 'MBR NO:' }, { controlType: 'Group', name: 'Member Search' }] }),
        ['MAIN'],
        0,
      ),
      controlFromUiaElement(
        el({ controlType: 'Edit', name: '', ancestors: [{ controlType: 'Text', name: 'BRANCH:' }, { controlType: 'Group', name: 'Member Search' }] }),
        ['MAIN'],
        1,
      ),
      controlFromUiaElement(el({ controlType: 'Button', name: 'Search', ancestors: [{ controlType: 'Group', name: 'Member Search' }] }), ['MAIN'], 2),
    ];
    const obs = { controls } as unknown as Observation;

    const found = resolveTarget(obs, target({ role: 'textbox', name: { value: 'MEMBER NUMBER', alternatives: ['MBR NO'] } }));
    expect(found.status).toBe('resolved');
    if (found.status === 'resolved') expect(found.control.ref).toBe('u0');

    const btn = resolveTarget(obs, target({ role: 'button', name: { value: 'Search' }, container: ['Member Search'] }));
    expect(btn.status).toBe('resolved');
    if (btn.status === 'resolved') expect(btn.control.ref).toBe('u2');
  });
});

describe('UiaSurface', () => {
  const s = new UiaSurface({ attachTo: { windowTitle: 'Riverbend Back Office' } });

  it('satisfies the Surface contract and reports the desktop kind', () => {
    expect(s.kind).toBe('desktop');
  });

  it('throws a SurfaceError naming what it would have done, on every method', async () => {
    const calls: Array<[string, () => unknown]> = [
      ['observe', () => s.observe()],
      ['navigate', () => s.navigate('process:1234')],
      ['click', () => s.click('u0')],
      ['type', () => s.type('u0', 'x', { clearFirst: true, pressEnter: false })],
      ['select', () => s.select('u0', 'CHECKING')],
      ['press', () => s.press('Enter')],
      ['answerDialog', () => s.answerDialog('accept')],
      ['screenshot', () => s.screenshot()],
      ['sourceSnapshot', () => s.sourceSnapshot()],
      ['close', () => s.close()],
      ['operator.click', () => s.operator.click(1, 2)],
      ['operator.typeText', () => s.operator.typeText('x')],
      ['operator.key', () => s.operator.key('Tab')],
      ['operator.scroll', () => s.operator.scroll(0, 120)],
      ['launch', () => UiaSurface.launch({})],
    ];
    for (const [name, call] of calls) {
      await expect(Promise.resolve().then(call), name).rejects.toThrow(/desktop surface not implemented: \S/);
    }
    expect(() => s.currentLocus()).toThrow(SurfaceError);
  });
});
