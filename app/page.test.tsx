import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './page';

describe('FlowPass JSON generator page', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('opens with four separate answers and three proposal scenarios', () => {
    render(<Page />);

    expect(
      screen.getByRole('heading', {
        name: '四個簡單問題，建立你的 AI 使用流向。',
      }),
    ).toBeInTheDocument();
    const presetGroup = screen.getByRole('group', { name: '情境範例' });
    expect(within(presetGroup).getAllByRole('button')).toHaveLength(3);

    const materials = screen.getByLabelText(
      '要處理什麼東西？',
    ) as HTMLTextAreaElement;
    const intendedUse = screen.getByLabelText(
      '想用 AI 做什麼？',
    ) as HTMLTextAreaElement;
    const personalData = screen.getByLabelText(
      '可能包含哪些個資或敏感資料？',
    ) as HTMLTextAreaElement;
    const destination = screen.getByLabelText(
      '完成後要放哪裡／分享給誰？',
    ) as HTMLTextAreaElement;
    const output = screen.getByTestId('json-output').textContent ?? '';
    const parsed = JSON.parse(output);

    expect(parsed.task.user_inputs).toEqual({
      materials: materials.value,
      intended_use: intendedUse.value,
      personal_or_sensitive_data: personalData.value,
      destination_and_audience: destination.value,
    });
  });

  it('loads all four answers from another FlowPass scenario', () => {
    render(<Page />);

    fireEvent.click(screen.getByRole('button', { name: /訪談錄音摘要/ }));

    expect(
      (screen.getByLabelText('要處理什麼東西？') as HTMLTextAreaElement)
        .value,
    ).toContain('訪談錄音');
    expect(
      (screen.getByLabelText('想用 AI 做什麼？') as HTMLTextAreaElement)
        .value,
    ).toContain('AI 轉錄');
    expect(
      (
        screen.getByLabelText(
          '可能包含哪些個資或敏感資料？',
        ) as HTMLTextAreaElement
      ).value,
    ).toContain('姓名');
    expect(
      (
        screen.getByLabelText(
          '完成後要放哪裡／分享給誰？',
        ) as HTMLTextAreaElement
      ).value,
    ).toContain('團隊成員');
    expect(screen.getByText('AI 轉錄')).toBeInTheDocument();
  });

  it('starts custom mode with four blank fields and requires only the first two', () => {
    render(<Page />);

    fireEvent.click(screen.getByRole('button', { name: '自行填寫' }));
    const materials = screen.getByLabelText('要處理什麼東西？');
    const intendedUse = screen.getByLabelText('想用 AI 做什麼？');
    const personalData = screen.getByLabelText(
      '可能包含哪些個資或敏感資料？',
    );
    const destination = screen.getByLabelText(
      '完成後要放哪裡／分享給誰？',
    );
    const generate = screen.getByRole('button', { name: /產生護照 JSON/ });

    expect(materials).toHaveValue('');
    expect(intendedUse).toHaveValue('');
    expect(personalData).toHaveValue('');
    expect(destination).toHaveValue('');
    expect(generate).toBeDisabled();

    fireEvent.change(materials, { target: { value: '活動照片' } });
    fireEvent.change(intendedUse, {
      target: { value: '用 AI 製作成果報告' },
    });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);

    const parsed = JSON.parse(
      screen.getByTestId('json-output').textContent ?? '',
    );
    expect(parsed.task.user_inputs).toEqual({
      materials: '活動照片',
      intended_use: '用 AI 製作成果報告',
      personal_or_sensitive_data: null,
      destination_and_audience: null,
    });
  });

  it('does not replace generated JSON while the form is still being edited', () => {
    render(<Page />);

    const before = screen.getByTestId('json-output').textContent;
    fireEvent.change(screen.getByLabelText('要處理什麼東西？'), {
      target: { value: '尚未送出的新資料' },
    });

    expect(screen.getByTestId('json-output').textContent).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: /產生護照 JSON/ }));
    expect(
      JSON.parse(screen.getByTestId('json-output').textContent ?? '').task
        .user_inputs.materials,
    ).toBe('尚未送出的新資料');
  });

  it('identifies required fields and associates every hint for assistive technology', () => {
    render(<Page />);

    const materials = screen.getByLabelText('要處理什麼東西？');
    const intendedUse = screen.getByLabelText('想用 AI 做什麼？');
    const personalData = screen.getByLabelText(
      '可能包含哪些個資或敏感資料？',
    );
    const destination = screen.getByLabelText(
      '完成後要放哪裡／分享給誰？',
    );

    expect(materials).toBeRequired();
    expect(intendedUse).toBeRequired();
    expect(personalData).not.toBeRequired();
    expect(destination).not.toBeRequired();
    expect(materials).toHaveAccessibleDescription(
      '只要說資料類型，不必貼上實際內容。',
    );
    expect(personalData).toHaveAccessibleDescription(
      '不知道也可以留白，系統會列為待確認；密碼、API 金鑰或營業秘密也算敏感資料。',
    );
  });

  it('prevents copying stale JSON until the edited form is generated again', async () => {
    render(<Page />);

    const copyButton = screen.getByRole('button', { name: '複製 JSON' });
    expect(copyButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText('要處理什麼東西？'), {
      target: { value: '另一批活動照片' },
    });
    expect(copyButton).toBeDisabled();
    fireEvent.click(copyButton);
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /產生護照 JSON/ }));
    expect(copyButton).toBeEnabled();
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it('copies the exact current JSON and announces success', async () => {
    render(<Page />);

    const output = screen.getByTestId('json-output').textContent ?? '';
    fireEvent.click(screen.getByRole('button', { name: '複製 JSON' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(output));
    expect(screen.getByRole('status')).toHaveTextContent('JSON 已複製');
  });

  it('keeps the JSON visible and announces a clipboard failure', async () => {
    writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    render(<Page />);

    const output = screen.getByTestId('json-output');
    fireEvent.click(screen.getByRole('button', { name: '複製 JSON' }));

    expect(output).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '無法自動複製，請直接選取 JSON。',
      ),
    );
  });

  it('switches workspaces without losing either draft', () => {
    render(<Page />);

    const workspace = screen.getByRole('group', { name: '工作模式' });
    fireEvent.change(screen.getByLabelText('要處理什麼東西？'), {
      target: { value: '尚未送出的活動照片' },
    });
    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));

    const parserInput = screen.getByLabelText(
      'AI 回傳 JSON',
    ) as HTMLTextAreaElement;
    expect(parserInput.value).toContain('passport_draft');
    fireEvent.change(parserInput, { target: { value: '{"draft":"保留我"}' } });

    fireEvent.click(
      within(workspace).getByRole('button', { name: '產生提示詞' }),
    );
    expect(screen.getByLabelText('要處理什麼東西？')).toHaveValue(
      '尚未送出的活動照片',
    );

    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));
    expect(screen.getByLabelText('AI 回傳 JSON')).toHaveValue(
      '{"draft":"保留我"}',
    );
  });

  it('parses the supplied sample into the hackathon passport summary', () => {
    render(<Page />);

    const workspace = screen.getByRole('group', { name: '工作模式' });
    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));
    fireEvent.click(screen.getByRole('button', { name: '開始解析護照' }));

    expect(
      screen.getByRole('heading', { name: '社團招生影片製作與發布' }),
    ).toBeVisible();
    const metrics = screen.getByLabelText('護照數量摘要');
    expect(within(metrics).getByText('8')).toBeVisible();
    expect(within(metrics).getByText('4 條連線')).toBeVisible();
    expect(within(metrics).getByText('4 項措施')).toBeVisible();
    expect(within(metrics).getByText('8 個問題')).toBeVisible();
  });

  it('creates one answer field per AI question and preserves answers across workspaces', () => {
    render(<Page />);

    const workspace = screen.getByRole('group', { name: '工作模式' });
    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));
    fireEvent.click(screen.getByRole('button', { name: '開始解析護照' }));

    const answerFields = screen.getAllByRole('textbox', {
      name: /^回答：/,
    });
    expect(answerFields).toHaveLength(8);
    expect(screen.queryAllByTestId('confirmation-question')).toHaveLength(0);
    fireEvent.change(answerFields[0], {
      target: { value: '使用 Runway 生成影片。' },
    });

    fireEvent.click(
      within(workspace).getByRole('button', { name: '產生提示詞' }),
    );
    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));

    expect(
      screen.getByRole('textbox', {
        name: /請指定具體使用的「AI 影片生成工具」名稱與供應商？/,
      }),
    ).toHaveValue('使用 Runway 生成影片。');
  });

  it('keeps invalid JSON editable and announces the error', () => {
    render(<Page />);

    const workspace = screen.getByRole('group', { name: '工作模式' });
    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));
    const parserInput = screen.getByLabelText('AI 回傳 JSON');
    fireEvent.change(parserInput, { target: { value: '{"passport_draft":' } });
    fireEvent.click(screen.getByRole('button', { name: '開始解析護照' }));

    expect(screen.getByRole('alert')).toHaveTextContent('JSON 格式無法解析');
    expect(parserInput).toHaveValue('{"passport_draft":');
  });

  it('shows the exact schema path for a missing use case', () => {
    render(<Page />);

    const workspace = screen.getByRole('group', { name: '工作模式' });
    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));
    const parserInput = screen.getByLabelText('AI 回傳 JSON');
    const parsed = JSON.parse((parserInput as HTMLTextAreaElement).value);
    delete parsed.passport_draft.use_case;
    fireEvent.change(parserInput, {
      target: { value: JSON.stringify(parsed) },
    });
    fireEvent.click(screen.getByRole('button', { name: '開始解析護照' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      '$.passport_draft.use_case',
    );
  });

  it('clears and reloads only the parser sample', () => {
    render(<Page />);

    const originalMaterials = (
      screen.getByLabelText('要處理什麼東西？') as HTMLTextAreaElement
    ).value;
    const workspace = screen.getByRole('group', { name: '工作模式' });
    fireEvent.click(within(workspace).getByRole('button', { name: '解析護照' }));

    fireEvent.click(screen.getByRole('button', { name: '清除 JSON' }));
    expect(screen.getByLabelText('AI 回傳 JSON')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '載入範例 JSON' }));
    expect(
      (screen.getByLabelText('AI 回傳 JSON') as HTMLTextAreaElement).value,
    ).toContain('社團招生影片製作與發布');

    fireEvent.click(
      within(workspace).getByRole('button', { name: '產生提示詞' }),
    );
    expect(screen.getByLabelText('要處理什麼東西？')).toHaveValue(
      originalMaterials,
    );
  });
});
