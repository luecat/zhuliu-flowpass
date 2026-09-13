import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { flowPassRichMenu, flowPassRichMenuImage } from './provision-line-rich-menu';

describe('FlowPass LINE rich menu', () => {
  it('uses a 2x2 layout for apply, passport check, progress, and FAQ', () => {
    const menu = flowPassRichMenu('2011336492-ay7OJ4mO');
    expect(menu.areas).toHaveLength(4);
    expect(menu.areas[0]).toMatchObject({
      bounds: { x: 0, y: 0, width: 1250, height: 843 },
      action: { type: 'uri', label: '申請', uri: 'https://liff.line.me/2011336492-ay7OJ4mO/?next=apply' },
    });
    expect(menu.areas[1]).toMatchObject({
      bounds: { x: 1250, y: 0, width: 1250, height: 843 },
      action: { type: 'uri', label: '檢測', uri: 'https://liff.line.me/2011336492-ay7OJ4mO/?next=tool-check' },
    });
    expect(menu.areas[2]).toMatchObject({
      bounds: { x: 0, y: 843, width: 1250, height: 843 },
      action: { type: 'uri', label: '進度查詢', uri: 'https://liff.line.me/2011336492-ay7OJ4mO/?next=passports' },
    });
    expect(menu.areas[3]).toMatchObject({
      bounds: { x: 1250, y: 843, width: 1250, height: 843 },
      action: { type: 'message', label: 'FAQ', text: '常見問題' },
    });
  });

  it('renders an uploadable 2500 by 1686 PNG', async () => {
    const image = await flowPassRichMenuImage();
    await expect(sharp(image).metadata()).resolves.toMatchObject({ format: 'png', width: 2500, height: 1686 });
    expect(image.byteLength).toBeLessThan(1024 * 1024);
  });
});
