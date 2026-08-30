import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SecurityAlerts } from './security-alerts';
describe('SecurityAlerts', () => { it('starts with safe empty state', () => { render(<SecurityAlerts caseId="case" />); expect(screen.getByLabelText('資安提醒清單')).toBeInTheDocument(); }); });
