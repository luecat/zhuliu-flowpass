import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { flowPassRichMenu, flowPassRichMenuImage } from './provision-line-rich-menu';

describe('FlowPass LINE rich menu', () => {
  it('uses valid LIFF entry and allow-listed query routing instead of appending to the endpoint path', () => {
    const menu = flowPassRichMenu('2011336492-ay7OJ4mO');
    expect(menu.areas[0].action.uri).toBe('https://liff.line.me/2011336492-ay7OJ4mO/?next=apply');
    expect(menu.areas[1].action.uri).toBe('https://liff.line.me/2011336492-ay7OJ4mO/?next=passports');
    expect(menu.areas.every((area) => area.bounds.width === 1250 && area.bounds.height === 1686)).toBe(true);
  });

  it('renders an uploadable 2500 by 1686 PNG', async () => {
    const image = await flowPassRichMenuImage();
    await expect(sharp(image).metadata()).resolves.toMatchObject({ format: 'png', width: 2500, height: 1686 });
    expect(image.byteLength).toBeLessThan(1024 * 1024);
  });
});
