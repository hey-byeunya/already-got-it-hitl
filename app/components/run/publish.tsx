'use client';

/**
 * 발행 게이트 — 브리핑을 슬랙에 내보내기 직전의 승인 화면 (DECISIONS.md D37~D43).
 *
 * 목표: 담당자가 이 화면만 보고 10초 안에 판단한다. 다른 화면을 열러 가게 하지 않는다.
 *   - [ PUBLISH GATE ] 구역: 멈춘 이유 · 판정에 쓴 값 · 핵심 정보와 통과시키면 · 네 가지 답
 *   - 보낼 원문은 따로 그리지 않는다. 아래 [ CARDS ] 가 곧 보낼 카드다 — 멈춘 원인과 관련된 카드를
 *     거기서 강조하고, 수정도 거기서 한다 (같은 내용을 두 번 그리면 어느 쪽을 봐야 할지 헷갈린다)
 *
 * 그래서 상태는 이 파일의 usePublish 한 곳에 두고, 실행 화면이 게이트·카드·결정 기록에 나눠 준다.
 *
 * 일부러 뺀 것: 도구 출력 원문·실행 로그·비용. 판단에 쓰는 값만 출처와 함께 추리고,
 * 나머지는 같은 페이지 아래쪽 로그에 둔다 — 승인 구역이 길어지면 읽지 않고 누르게 된다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionHead } from '@/components/term';
import { stamp } from './format';

type Hit = { rule: string; card_no: number | null; detail: string; label: string; risk: string };
type Card = {
  card_no: number; kind: 'cover' | 'metric' | 'text'; title: string; body: string[]; sources: string[];
  category?: 'fix_now' | 'watch' | 'fyi'; accent?: 'accent' | 'warn' | 'bad';
};
type CardEdit = { card_no: number; title?: string; body?: string[]; remove?: boolean };
type Decision = {
  at: string; action: 'approve' | 'edit' | 'reject' | 'retry';
  reason?: string; instruction?: string; edits?: CardEdit[];
};
export type PublishView = {
  publish: {
    version: number; route: 'review' | 'auto';
    status: 'pending_review' | 'retrying' | 'approved' | 'rejected' | 'sending' | 'published' | 'send_failed';
    gate: { stop: boolean; hits: Hit[]; checked_cards: number };
    decisions: Decision[]; retries: number; edits: CardEdit[];
    created_at: string; updated_at: string;
    sent?: { at: string; dry_run: boolean; channel: 'slack' }; error?: string;
  };
  related: { card_no: number; rules: string[] }[];
  signals: {
    deploy_failed: number | null; errors_total: number | null; errors_prev: number | null;
    oldest_issue_days: number | null; oldest_issue_number: number | null;
    missing_tools: string[];
  };
  cards: Card[]; original: Card[];
  summary: { cards: number; fix_now: number; removed: number };
  dry_run: boolean;
  retry: { max: number; used: number; available: boolean };
  run: { goal: string; period: { since: string; until: string } | null; fixture_id: string | null; created_at: string; live: boolean; waiting_question: boolean } | null;
};

const POLL_MS = 1500;
const DONE = new Set(['published', 'rejected']);
export const NETWORK_ERR = '서버에 닿지 못했다. 보내지지 않았으니 다시 누른다';

const FACE: Record<PublishView['publish']['status'], { text: string; tone: 'ok' | 'warn' | 'bad' | 'mut' }> = {
  pending_review: { text: 'waiting for human', tone: 'warn' },
  retrying: { text: 'retrying', tone: 'warn' },
  approved: { text: 'ready to send', tone: 'ok' },
  sending: { text: 'sending', tone: 'ok' },
  published: { text: 'published', tone: 'ok' },
  rejected: { text: 'rejected', tone: 'mut' },
  send_failed: { text: 'send failed', tone: 'bad' },
};

export const ACTION_LABEL: Record<Decision['action'], string> = {
  approve: 'approve', edit: 'edit & approve', reject: 'reject', retry: 'retry',
};

/** 기준 id 를 카드 딱지에 쓸 짧은 이름으로. */
export const RULE_TAG: Record<string, string> = {
  deploy_failed: 'deploy failed', errors_up: 'errors up', stale_issue: 'stale issue', tool_failed: 'tool failed',
};

/** 모르는 값은 0 으로 그리지 않는다 — 「모름」이다. */
function Known({ v, suffix = '' }: { v: number | null; suffix?: string }) {
  return v === null ? <span className="wrn">모름</span> : <span className="ink">{v}{suffix}</span>;
}

/** 수정 중인 카드. removed 면 보내지 않는다 (원본 카드 파일은 그대로). */
export type Draft = { title: string; body: string; removed: boolean };

/** 게이트 · 카드 · 결정 기록이 함께 보는 발행 상태. */
export type PublishCtl = {
  view: PublishView | null;
  busy: boolean;
  err: string | null;
  mode: null | 'edit' | 'reject' | 'retry';
  setMode: (m: null | 'edit' | 'reject' | 'retry') => void;
  drafts: Record<number, Draft>;
  setDraft: (card_no: number, d: Draft) => void;
  /** 카드 번호 → 관련된 기준 id 들. */
  related: Map<number, string[]>;
  startEdit: () => void;
  send: (payload: Record<string, unknown>) => Promise<void>;
  resend: () => Promise<void>;
  editsPayload: () => CardEdit[];
};

/** 발행 기록이 없을 때 몇 번까지 다시 볼지. 게이트 전의 옛 실행을 영원히 묻지 않게 한다. */
const MAX_MISSES = 5;

/**
 * `watch` 는 실행 상태다. 바뀌면(running → done 등) 다시 보기 시작한다 —
 * 발행 기록이 없는 동안 계속 묻지 않고, 기록이 생길 만한 때만 다시 묻는다.
 */
export function usePublish(runId: string, enabled: boolean, watch?: string): PublishCtl {
  const [view, setView] = useState<PublishView | null>(null);
  const [mode, setModeState] = useState<null | 'edit' | 'reject' | 'retry'>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const misses = useRef(0);

  const load = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const res = await fetch(`/api/runs/${runId}/publish`, { cache: 'no-store' }).catch(() => null);
    if (res && res.ok) {
      misses.current = 0;
      const v = await res.json() as PublishView;
      setView(v);
      if (!DONE.has(v.publish.status)) timer.current = setTimeout(() => void load(), POLL_MS);
      return;
    }
    // 게이트는 실행이 끝난 뒤 따로 돈다. 아직 기록이 없을 수 있으니 조금 뒤에 다시 본다.
    // 몇 번 봐도 없으면(게이트 전의 옛 실행 · 아직 도는 실행) 멈추고, 실행 상태가 바뀔 때 다시 본다.
    setView(null);
    misses.current += 1;
    if (misses.current < MAX_MISSES) timer.current = setTimeout(() => void load(), POLL_MS * 2);
  }, [runId]);

  useEffect(() => {
    if (!enabled) return;
    misses.current = 0;
    void load();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [load, enabled, watch]);

  // 지운 카드도 되살릴 수 있게 원본 기준으로 고친다. 지금 모습 = 원본 + 지난 고침.
  const originals = (view?.original ?? []).filter((c) => c.kind !== 'cover');
  const prevEdit = (n: number) => view?.publish.edits.find((e) => e.card_no === n);
  const current = (c: Card) => {
    const e = prevEdit(c.card_no);
    return { title: e?.title ?? c.title, body: e?.body ?? c.body, removed: Boolean(e?.remove) };
  };

  function setMode(m: null | 'edit' | 'reject' | 'retry') {
    setModeState(m); setErr(null);
    if (m !== 'edit') setDrafts({});
  }

  function startEdit() {
    const d: Record<number, Draft> = {};
    for (const c of originals) {
      const cur = current(c);
      d[c.card_no] = { title: cur.title, body: cur.body.join('\n'), removed: cur.removed };
    }
    setDrafts(d); setModeState('edit'); setErr(null);
  }

  /** 지금 모습에서 바뀐 카드만 보낸다. 하나도 안 바뀌었으면 서버가 edits_required 로 거절한다. */
  function editsPayload(): CardEdit[] {
    return originals.flatMap((c) => {
      const d = drafts[c.card_no];
      if (!d) return [];
      const cur = current(c);
      const lines = d.body.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
      const titleChanged = d.title !== cur.title;
      const bodyChanged = lines.join('\n') !== cur.body.join('\n');
      const removeChanged = d.removed !== cur.removed;
      if (!titleChanged && !bodyChanged && !removeChanged) return [];
      return [{
        card_no: c.card_no,
        ...(titleChanged ? { title: d.title } : {}), ...(bodyChanged ? { body: lines } : {}),
        ...(removeChanged ? { remove: d.removed } : {}),
      }];
    });
  }

  async function send(payload: Record<string, unknown>) {
    if (!view) return;
    setBusy(true); setErr(null);
    const res = await fetch(`/api/runs/${runId}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, version: view.publish.version }),
    }).catch(() => null);
    // 서버에 닿지 못하면 버튼이 잠긴 채 남지 않게 풀고 이유를 보인다. 답은 보내지지 않았다.
    if (!res) {
      setErr(`network - ${NETWORK_ERR}`);
      setBusy(false);
      return;
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { error?: string; message?: string };
      setErr(`${b.error ?? res.status} - ${b.message ?? '요청이 거절됐다'}`);
    } else {
      setModeState(null); setDrafts({});
    }
    setBusy(false);
    await load();
  }

  /** 보내지 못한 건을 다시 보낸다 (send_failed 에서만). */
  async function resend() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/runs/${runId}/publish/send`, { method: 'POST' }).catch(() => null);
    if (!res) {
      setErr(`network - ${NETWORK_ERR}`);
      setBusy(false);
      return;
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { error?: string; message?: string };
      setErr(`${b.error ?? res.status} - ${b.message ?? '다시 보내지 못했다'}`);
    }
    setBusy(false);
    await load();
  }

  const related = new Map((view?.related ?? []).map((r) => [r.card_no, r.rules]));
  return {
    view, busy, err, mode, setMode, drafts, resend,
    setDraft: (n, d) => setDrafts((prev) => ({ ...prev, [n]: d })),
    related, startEdit, send, editsPayload,
  };
}

export function PublishGate({ ctl, runId }: { ctl: PublishCtl; runId: string }) {
  const { view, busy, err, mode } = ctl;
  const [reason, setReason] = useState('');
  const [instruction, setInstruction] = useState('');
  if (!view) return null;

  const p = view.publish;
  const asking = p.status === 'retrying' && Boolean(view.run?.waiting_question);
  const face = asking ? { text: 'retrying · agent asks', tone: 'warn' as const } : FACE[p.status];
  const waiting = p.status === 'pending_review';
  const sig = view.signals;
  const retryLeft = view.retry.max - view.retry.used;
  const relatedNos = [...ctl.related.keys()];

  return (
    <div className="strip" id="publish" style={{ borderLeft: `2px solid var(--${face.tone === 'bad' ? 'danger' : face.tone === 'warn' ? 'warn' : face.tone === 'ok' ? 'accent' : 'line-hi'})` }}>
      <SectionHead
        tone={face.tone}
        label={`[ PUBLISH GATE ] slack · ${face.text}`}
        right={<span className="fnt" style={{ fontSize: 11 }}>
          {p.route === 'auto' ? 'passed · auto' : 'stopped · human review'} · v{p.version}
        </span>} />

      {/* 자동으로 나간 건은 짧게. 무엇이 나갔는지만 보인다. */}
      {p.route === 'auto' && (
        <div className="mut">
          기준 네 가지에 모두 걸리지 않아 <span className="ink">사람을 거치지 않고</span> {p.status === 'send_failed' ? '보내려 했다' : '보냈다'}
          {p.sent && <> · {stamp(p.sent.at)} · {p.sent.dry_run
            ? <span className="wrn">DRY_RUN - 보내지 않고 slack-dryrun.json 에 남겼다</span>
            : <span className="ok">슬랙으로 보냄</span>}</>}
        </div>
      )}

      {p.route === 'review' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18, marginTop: 4 }}>

          {/* 멈춘 이유 — 가장 먼저 읽힌다 (4강 5요소 ④). 출처는 오른쪽 「판정에 쓴 값」에 있다 */}
          <section>
            <div className="sechead wrn" style={{ fontSize: 11, marginBottom: 6 }}>WHY STOPPED</div>
            {p.gate.hits.length === 0 && (
              <div className="mut">기준에는 걸리지 않았다 - 다시 판정으로 고친 건이라 사람에게 다시 보인다</div>
            )}
            {p.gate.hits.map((h, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div><span className="wrn">■</span> <b className="ink">{h.label}</b></div>
                <div className="mut" style={{ paddingLeft: 14 }}>{h.detail}</div>
                <div className="prose" style={{ paddingLeft: 14, fontSize: 12 }}>막으려는 위험 · {h.risk}</div>
              </div>
            ))}
          </section>

          {/* 판정과 근거 — 게이트가 본 값과 출처. 모르는 값은 「모름」 (③) */}
          <section>
            <div className="sechead" style={{ fontSize: 11, marginBottom: 6 }}>SIGNALS · EVIDENCE</div>
            <div className="mut">배포 실패 <Known v={sig.deploy_failed} suffix="건" />
              <span className="fnt"> · get_system_health · summary.error</span></div>
            <div className="mut">앱 에러 <Known v={sig.errors_prev} /> → <Known v={sig.errors_total} suffix="건" />
              <span className="fnt"> · get_user_metrics · totals.errors_total</span></div>
            <div className="mut">가장 오래 열린 이슈{' '}
              {sig.oldest_issue_number !== null && <span className="ink">#{sig.oldest_issue_number} </span>}
              <Known v={sig.oldest_issue_days} suffix="일" />
              <span className="fnt"> · get_dev_activity · summary.oldest_open_issue_days</span></div>
            <div className="mut">성공하지 못한 도구{' '}
              {sig.missing_tools.length
                ? <span className="wrn">{sig.missing_tools.join(', ')}</span>
                : <span className="ink">없음</span>}</div>
          </section>

          {/* 핵심 정보 · 통과시키면 (② · ⑤) */}
          <section>
            <div className="sechead" style={{ fontSize: 11, marginBottom: 6 }}>SUMMARY · IF APPROVED</div>
            <div className="mut">
              기간 <span className="ink">{view.run?.period ? `${view.run.period.since} ~ ${view.run.period.until}` : '기록 없음'}</span>
              {' · '}카드 <span className="ink">{view.summary.cards}장</span>
              {' · '}손봐야 할 것 <span className={view.summary.fix_now ? 'bad' : 'ink'}>{view.summary.fix_now}</span>
              {p.edits.filter((e) => !e.remove).length > 0 && <> · <span className="wrn">고친 카드 {p.edits.filter((e) => !e.remove).length}장</span></>}
              {view.summary.removed > 0 && <> · <span className="wrn">지운 카드 {view.summary.removed}장</span></>}
            </div>
            {!waiting ? (
              <div className="mut" style={{ marginTop: 4 }}>
                {p.status === 'rejected' ? '반려했다 - 보내지 않았다'
                  : p.status === 'published' ? (p.sent?.dry_run ? 'DRY_RUN 으로 처리했다 - slack-dryrun.json 에 남겼다' : '슬랙으로 보냈다')
                  : p.status === 'retrying' ? '에이전트가 고치는 중이다 - 끝나면 다시 묻는다'
                  : face.text}
              </div>
            ) : view.dry_run ? (
              <div className="wrn" style={{ marginTop: 4 }}>
                지금은 DRY_RUN 이다 - 승인해도 <b>보내지 않고</b> runs/{runId}/slack-dryrun.json 에 보낼 내용만 남긴다
              </div>
            ) : (
              <div className="bad" style={{ marginTop: 4 }}>
                승인하면 <b>슬랙 채널에 카드 {view.summary.cards}장이 메시지 하나로</b> 올라간다.
                웹훅으로 보낸 메시지는 <b>지울 수 없다.</b>
              </div>
            )}
          </section>
        </div>
      )}

      {/* 보낼 원문은 아래 [ CARDS ] 다. 관련 카드가 어디 있는지만 알린다 */}
      {p.route === 'review' && (
        <div className="note" style={{ marginTop: 10 }}>
          {relatedNos.length
            ? <>관련 카드 <span className="wrn">{relatedNos.map((n) => String(n).padStart(2, '0')).join(', ')}</span> - 아래 [ CARDS ] 에 강조했다. 보낼 원문은 [ CARDS ] 그대로다</>
            : '보낼 원문은 아래 [ CARDS ] 그대로다'}
          {mode === 'edit' && <span className="wrn"> · 지금 [ CARDS ] 에서 고치는 중</span>}
        </div>
      )}

      {/* 네 가지 답 */}
      {waiting && (
        <div style={{ marginTop: 12 }}>
          {mode === null && (
            <div className="row" style={{ gap: 8 }}>
              <button className="primary" disabled={busy} onClick={() => void ctl.send({ action: 'approve' })}>
                approve - send as is
              </button>
              <button disabled={busy} onClick={ctl.startEdit}>edit &amp; approve</button>
              <button className="danger" disabled={busy} onClick={() => ctl.setMode('reject')}>reject</button>
              <button disabled={busy || !view.retry.available || retryLeft <= 0}
                title={!view.retry.available ? '이어서 고칠 에이전트 세션이 없다' : retryLeft <= 0 ? '다시 판정은 두 번까지다' : undefined}
                onClick={() => ctl.setMode('retry')}>
                retry ({retryLeft}/{view.retry.max})
              </button>
            </div>
          )}

          {mode === 'edit' && (
            <div className="row" style={{ gap: 8 }}>
              <button className="primary" disabled={busy} onClick={() => void ctl.send({ action: 'edit', edits: ctl.editsPayload() })}>
                approve with edits
              </button>
              <button disabled={busy} onClick={() => ctl.setMode(null)}>cancel</button>
              <span className="note">[ CARDS ] 에서 고치거나 remove 로 지운다 · 바뀐 카드만 보내고 원본 카드 파일은 그대로 둔다</span>
            </div>
          )}

          {mode === 'reject' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <label className="mut" htmlFor="reject-reason">reject reason - 나중에 왜 막았는지 추적하고, 기준을 고칠 재료가 된다</label>
              <input id="reject-reason" type="text" value={reason} placeholder="예: 배포는 이미 복구됐고 원인도 기록돼 있다. 이번 주는 보낼 필요 없음"
                onChange={(e) => setReason(e.target.value)} />
              <div className="row" style={{ gap: 8 }}>
                <button className="danger" disabled={busy || !reason.trim()}
                  onClick={() => void ctl.send({ action: 'reject', reason }).then(() => setReason(''))}>
                  reject - don&apos;t send
                </button>
                <button disabled={busy} onClick={() => ctl.setMode(null)}>cancel</button>
              </div>
            </div>
          )}

          {mode === 'retry' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <label className="mut" htmlFor="retry-instruction">
                retry instruction - 에이전트가 <span className="ink">저장한 세션으로 이어서</span> 해당 카드만 고친다
              </label>
              <input id="retry-instruction" type="text" value={instruction}
                placeholder="예: 2번 카드에 복구 시각과 원인 커밋을 넣어 다시 써"
                onChange={(e) => setInstruction(e.target.value)} />
              <div className="row" style={{ gap: 8 }}>
                <button className="primary" disabled={busy || !instruction.trim()}
                  onClick={() => void ctl.send({ action: 'retry', instruction }).then(() => setInstruction(''))}>
                  retry - rerun agent
                </button>
                <button disabled={busy} onClick={() => ctl.setMode(null)}>cancel</button>
                <span className="wrn" style={{ fontSize: 11 }}>에이전트 호출이라 비용이 든다 · 남은 {retryLeft}번</span>
              </div>
            </div>
          )}
        </div>
      )}

      {p.status === 'retrying' && (
        <div className="wrn" style={{ marginTop: 10 }}>
          {asking
            ? <>에이전트가 <b>질문에 답을 기다린다</b> - 위의 질문(waiting for answer)에 답하면 이어서 고치고, 끝나면 다시 판정해 이 화면에 올린다</>
            : '에이전트가 지시대로 카드를 고치는 중이다 - 끝나면 다시 판정해 이 화면에 다시 올린다'}
        </div>
      )}

      {p.status === 'send_failed' && (
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <span className="bad">슬랙으로 보내지 못했다 - {p.error}</span>
          <button className="primary" disabled={busy} onClick={() => void ctl.resend()}>resend</button>
          <span className="note">
            {p.route === 'auto' ? '기준을 통과한 건이다' : '사람의 승인은 이미 받은 건이다'} · 웹훅 설정을 고친 뒤 다시 보낸다
          </span>
        </div>
      )}
      {err && <div className="bad" style={{ marginTop: 10 }}>{err}</div>}
      {p.error && p.status !== 'send_failed' && <div className="bad" style={{ marginTop: 10 }}>{p.error}</div>}
    </div>
  );
}

/**
 * [ DECIDED BY HUMAN ] 에 붙는 발행 결정 줄. 고친 건 어느 카드였는지 제목과 함께 보인다.
 */
export function PublishDecisions({ view }: { view: PublishView | null }) {
  if (!view || (view.publish.decisions.length === 0 && !view.publish.sent)) return null;
  const titleOf = (n: number) => (view.original.find((c) => c.card_no === n)?.title ?? '').replace(/\s*\n\s*/g, ' ');
  return (
    <>
      {view.publish.decisions.map((d, i) => (
        <div className="spread" key={`pub-${i}`} style={{ padding: '7px 0', borderBottom: '1px solid var(--line-faint)', gap: 16 }}>
          <span className="mut" style={{ minWidth: 0 }}>
            publish · <span className="ink">{ACTION_LABEL[d.action]}</span> <span className="fnt">{stamp(d.at)}</span>
            {d.edits?.map((e) => (
              <div key={e.card_no} className="fnt" style={{ fontSize: 11 }}>
                card {String(e.card_no).padStart(2, '0')} 「{titleOf(e.card_no)}」
                {e.remove === true && <span className="bad"> · removed</span>}
                {e.remove === false && <span className="ok"> · restored</span>}
                {e.title !== undefined && <> → <span className="ink">「{e.title}」</span></>}
                {e.body !== undefined && <span className="wrn"> · 본문 수정</span>}
              </div>
            ))}
          </span>
          <span className={d.action === 'reject' ? 'bad' : d.action === 'retry' ? 'wrn' : 'ok'} style={{ textAlign: 'right' }}>
            {d.reason ?? d.instruction ?? (d.action === 'edit' ? `카드 ${d.edits?.length ?? 0}장 고쳐 보냄` : '그대로 보냄')}
          </span>
        </div>
      ))}
      {view.publish.sent && (
        <div className="spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--line-faint)' }}>
          <span className="mut">publish · <span className="ink">sent</span> <span className="fnt">{stamp(view.publish.sent.at)}</span></span>
          <span className={view.publish.sent.dry_run ? 'wrn' : 'ok'}>
            {view.publish.sent.dry_run ? 'DRY_RUN - slack-dryrun.json 에 남김' : '슬랙으로 보냄'}
          </span>
        </div>
      )}
    </>
  );
}
