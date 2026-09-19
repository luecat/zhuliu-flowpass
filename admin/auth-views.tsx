import { useState, type FormEvent } from 'react';

function Password({ id, title, value, setValue, auto = 'current-password' }: { id: string; title: string; value: string; setValue: (value: string) => void; auto?: string }) {
  const [show, setShow] = useState(false);
  return <div className="field"><label htmlFor={id}>{title}</label><div className="password"><input id={id} type={show ? 'text' : 'password'} value={value} autoComplete={auto} onChange={(e) => setValue(e.target.value)} required /><button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? '隱藏' : '顯示'}</button></div></div>;
}

function Rules({ password }: { password: string }) {
  const values: [string, boolean][] = [['長度介於 8 到 128 個字元', Array.from(password).length >= 8 && Array.from(password).length <= 128], ['包含英文大寫字母', /[A-Z]/.test(password)], ['包含英文小寫字母', /[a-z]/.test(password)], ['包含數字', /\d/.test(password)], ['包含特殊字元', /[^A-Za-z0-9]/.test(password)], ['不含完整帳號名稱', !password.toLowerCase().includes('admin')]];
  return <ul className="rules" aria-label="密碼規則">{values.map(([text, pass]) => <li className={pass ? 'pass' : ''} key={text}><span aria-hidden="true">{pass ? '✓' : '○'}</span>{text}</li>)}</ul>;
}

export function Login({ busy, error, submit, forgot }: { busy: boolean; error: string; submit: (account: string, password: string) => Promise<void>; forgot: () => void }) {
  const [password, setPassword] = useState('');
  return <main className="auth"><section className="card"><p className="eyebrow">FLOWPASS · ADMIN</p><h1>管理後台登入</h1><p className="intro">登入後才能存取案件與審核資料。首次使用預設帳號後，系統會要求立即設定新密碼。</p><form onSubmit={(e) => { e.preventDefault(); void submit('admin', password).finally(() => setPassword('')); }}><div className="field"><span id="account-label">管理員帳號</span><output aria-labelledby="account-label" style={{ width: '100%', padding: '.68rem .75rem', border: '1px solid #b8c9bf', borderRadius: '.55rem', background: '#f3f7f4', color: '#1d2e26', fontWeight: 700 }}>admin</output></div><Password id="login-password" title="密碼" value={password} setValue={setPassword} />{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? '登入中…' : '登入'}</button></form><button className="link" onClick={forgot}>忘記密碼？</button><p className="security">密碼復原需啟用 Cloudflare Access 身分驗證，目前已停用，請妥善保管密碼。</p></section></main>;
}

export function PasswordChange({ forced, busy, error, save, back }: { forced: boolean; busy: boolean; error: string; save: (current: string, next: string) => Promise<void>; back: () => void }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState(''), [local, setLocal] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (next !== confirm) { setLocal('兩次輸入的新密碼不一致。'); return; } setLocal(''); void save(current, next); };
  return <main className="auth"><section className="card"><p className="eyebrow">帳號安全</p><h1>{forced ? '請先變更初始密碼' : '變更密碼'}</h1><p className="intro">{forced ? '完成前無法使用其他管理功能。' : '更新後，其他裝置上的登入工作階段將失效。'}</p><form onSubmit={submit}><Password id="current-password" title="目前密碼" value={current} setValue={setCurrent} /><Password id="new-password" title="新密碼" value={next} setValue={setNext} auto="new-password" /><Rules password={next} /><Password id="confirm-password" title="確認新密碼" value={confirm} setValue={setConfirm} auto="new-password" />{(error || local) && <p className="error" role="alert">{local || error}</p>}<button className="primary" disabled={busy}>{busy ? '儲存中…' : '儲存新密碼'}</button></form>{!forced && <button className="link" onClick={back}>返回案件總覽</button>}</section></main>;
}

export function Recovery({ busy, error, start, complete, back }: { busy: boolean; error: string; start: () => Promise<string | null>; complete: (token: string, password: string) => Promise<void>; back: () => void }) {
  const [token, setToken] = useState<string | null>(null), [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [notice, setNotice] = useState(''), [local, setLocal] = useState('');
  const doStart = () => void start().then((value) => { setToken(value); setNotice(value ? '身分驗證已完成，請設定新密碼。' : '密碼復原需啟用 Cloudflare Access 身分驗證，目前無法使用。'); });
  return <main className="auth"><section className="card"><p className="eyebrow">帳號復原</p><h1>忘記密碼</h1><p className="intro">復原只接受已驗證的指定管理信箱，不會在本機顯示或傳送復原信箱。</p>{!token ? <><button className="primary" onClick={doStart} disabled={busy}>{busy ? '驗證中…' : '開始安全復原'}</button>{notice && <p className="notice" role="status">{notice}</p>}</> : <form onSubmit={(e) => { e.preventDefault(); if (password !== confirm) { setLocal('兩次輸入的新密碼不一致。'); return; } void complete(token, password); }}><Password id="recovery-password" title="新密碼" value={password} setValue={setPassword} auto="new-password" /><Rules password={password} /><Password id="recovery-confirm" title="確認新密碼" value={confirm} setValue={setConfirm} auto="new-password" /><button className="primary" disabled={busy}>{busy ? '重設中…' : '重設密碼並返回登入'}</button></form>}{(error || local) && <p className="error" role="alert">{local || error}</p>}<button className="link" onClick={back}>返回登入</button></section></main>;
}
