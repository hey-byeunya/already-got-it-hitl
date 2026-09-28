'use client';

/**
 * 발행 대기 목록 — 슬랙으로 내보내기 전에 사람의 답을 기다리는 브리핑.
 * 한 건을 누르면 그 실행 화면의 발행 게이트(5요소·네 가지 답)로 간다.
 * 자동으로 나간 건과 이미 답한 건도 아래에 남긴다 — 무엇이 사람을 거쳤는지 한눈에 보이게.
 */
import Link from 'next/link';
import { Lights, SectionHead } from '@/components/term';
import { useQueue, type QueueRow } from '@/components/publish-queue';
import { stamp } from '@/components/run/format';

const FACE: Record<QueueRow['status'], [string, string]> = {
  pending_review: ['waiting for human', 'wrn'], retrying: ['retrying', 'wrn'], send_failed: ['send failed', 'bad'],
  approved: ['ready to send', 'ok'], sending: ['sending', 'ok'], published: ['published', 'ok'], rejected: ['rejected', 'mut'],
};
const NEEDS = new Set<QueueRow['status']>(['pending_review', 'send_failed']);
const needs = (r: QueueRow) => NEEDS.has(r.status) || (r.status === 'retrying' && r.waiting_question);

export default function PublishQueuePage() {
  const q = useQueue();
  const need = q?.rows.filter(needs) ?? [];
  const rest = q?.rows.filter((r) => !needs(r)) ?? [];

  const Row = ({ r }: { r: QueueRow }) => {
    // 다시 판정 중인 에이전트가 사람에게 묻고 있으면, retrying 에 멈춘 것이 아니라 답을 기다리는 것이다.
    const [text, tone] = r.status === 'retrying' && r.waiting_question ? ['agent asks - 실행 화면에서 답한다', 'wrn'] : FACE[r.status];
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 140px 130px', gap: 12,
        padding: '10px 0', borderBottom: '1px solid var(--line-faint)', fontSize: 12, alignItems: 'baseline' }}>
        <span style={{ minWidth: 0 }}>
          <Link href={`/runs/${r.run_id}#publish`}>{r.run_id}</Link>
          <span className="fnt" style={{ fontSize: 11 }}>
            {r.period ? ` · ${r.period.since} ~ ${r.period.until}` : ''}
          </span>
          <br />
          <span className="mut" style={{ fontSize: 11.5 }}>
            {r.route === 'auto' ? 'passed - 사람을 거치지 않음' : r.rules.length ? r.rules.join(' · ') : '다시 판정한 건'}
          </span>
        </span>
        <span className={tone}>{text}</span>
        {/* 기록은 UTC 로 남는다. 읽는 자리에서 현지 시각으로 바꾼다 (실행 화면 로그와 같은 stamp) */}
        <span className="fnt" style={{ fontSize: 11, textAlign: 'right' }}>{stamp(r.updated_at)}</span>
      </div>
    );
  };

  return (
    <main>
      <div className="win">
        <div className="titlebar">
          <div className="row" style={{ gap: 12 }}>
            <Lights />
            <span className="mut">ops-brief</span><span className="fnt">-</span>
            <span className="ink">publish</span>
          </div>
          <Link href="/" className="mut" style={{ fontSize: 11 }}>cd ..</Link>
        </div>
        <div className="pane">
          {q?.dry_run && (
            <div className="wrn" style={{ fontSize: 12, marginBottom: 14 }}>
              DRY_RUN 이다 - 승인해도 슬랙으로 보내지 않고 각 실행의 slack-dryrun.json 에 남긴다
            </div>
          )}
          <SectionHead tone={need.length ? 'warn' : 'ok'} label={`[ NEEDS ANSWER ] ${need.length}`} />
          {!q && <div className="note">불러오는 중…</div>}
          {q && need.length === 0 && <div className="note">지금 사람의 답을 기다리는 브리핑이 없다.</div>}
          {need.map((r) => <Row key={r.run_id} r={r} />)}

          <div style={{ height: 22 }} />
          <SectionHead tone="mut" label={`[ HANDLED ] ${rest.length}`} />
          {rest.map((r) => <Row key={r.run_id} r={r} />)}
        </div>
      </div>
    </main>
  );
}
