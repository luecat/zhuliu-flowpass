import Link from 'next/link';

export default function ApplicantHome() {
  return <section className="applicant-home" aria-labelledby="app-title">
    <p className="eyebrow">竹流 FlowPass</p>
    <h1 id="app-title">把申請資料整理成清楚的使用流向</h1>
    <p>先回答四個問題，確認後再整理護照草稿。</p>
    <nav aria-label="申請功能" className="applicant-actions">
      <Link className="primary-action" href="/app/apply">送出申請</Link>
      <span className="secondary-action pending" aria-disabled="true" title="護照查詢將在歷史紀錄功能完成後開放">護照查詢（即將開放）</span>
    </nav>
    <p className="pending-note" role="status">護照查詢正在準備中；目前可先建立新的申請草稿。</p>
  </section>;
}
