import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ChoiceList } from './choice-list';

function Harness() {
  const [value, setValue] = useState('');
  return (
    <ChoiceList
      label="軟體名稱"
      searchable
      value={value}
      onChange={setValue}
      options={[{ value: 'chatgpt', label: 'ChatGPT', hint: 'OpenAI' }, { value: 'canva', label: 'Canva AI', hint: 'Canva' }]}
    />
  );
}

describe('ChoiceList', () => {
  it('fills the searchable input and closes the menu after tapping an option', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: '軟體名稱' });
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole('button', { name: /Canva AI/ }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('Canva AI');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
});
