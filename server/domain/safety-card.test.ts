import { describe, expect, it } from 'vitest';
import { FLOWPASS_SAMPLE } from '../../app/passport-sample';
import { inspectPassportDocument } from './passport-validation';
import { buildSafetyCardModel, renderSafetyCardSvg } from './safety-card';

describe('safety card', () => {
  it('builds a personalized SVG card from a passport', () => {
    const inspected = inspectPassportDocument(structuredClone(FLOWPASS_SAMPLE));
    expect(inspected.canonical).toBeTruthy();
    const model = buildSafetyCardModel(inspected.canonical!);
    expect(model.flow.length).toBeGreaterThan(0);
    expect(model.incidentSteps).toHaveLength(5);
    const svg = renderSafetyCardSvg(model);
    expect(svg).toContain('<svg');
    expect(svg).toContain(model.title);
  });

  it('describes the flow as ordered stages instead of from → to pairs', () => {
    const model = buildSafetyCardModel(inspectPassportDocument(structuredClone(FLOWPASS_SAMPLE)).canonical!);
    expect(model.flow.map((line) => line.split('：')[0])).toEqual(['用到的資料', '交給 AI 處理', '存放位置', '分享與發布']);
    expect(model.flow.join('')).not.toContain('→');
  });
});
