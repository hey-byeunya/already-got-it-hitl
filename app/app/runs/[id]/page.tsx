'use client';

/**
 * 실행 상세 — 터미널 화면.
 *
 * 위에서 아래로: 타이틀바 · 프롬프트 헤더 · 계기 3분할 · 게이트(승인/질문/중단/종료) ·
 * 사람이 결정한 것 · 본문 2단(카드 또는 원고 | 로그).
 *
 * 화면이 지켜야 할 것 두 가지:
 *  1. **모르는 것을 0 으로 그리지 않는다.** usage_known:false 는 «확인 못 함» 이다.
 *  2. **누를 수 없는 버튼을 보여주지 않는다.** 콜백이 사라진 대기는 무효로 표시하고 비활성한다.
 */

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Cursor, Gauge, Lights, SectionHead, StatusBadge, TERMINAL_STATUSES, clock,
} from '@/components/term';
import type { RunDetail, TraceEvent } from '@/lib/types';
import { CardModal, CardsPane } from '@/components/run/cards';
import { QuestionGate } from '@/components/run/question';
import { NETWORK_ERR, PublishDecisions, PublishGate, usePublish } from '@/components/run/publish';
import { Out } from '@/components/run/links';
import { STEP_MARK, credLine, glyph, hhmmss, stamp, summaryLines } from '@/components/run/format';

type Conflict = { code: string; message: string };

const POLL_MS = 1200;
const NARROW = 1080;
/** 로그 한 쪽에 담는 줄 수. 실행 하나가 60줄을 넘기니 전부 펼치면 스크롤이 감당이 안 된다. */
const LOG_PAGE = 10;

/**
 * n 번째 승인 결정의 이슈 제목을 승인 대기 로그에서 찾는다. 예전 기록은 결정에 제목을 남기지 않았다.
 * 로그 입력은 잘려 있을 수 있어 JSON 으로 읽지 않고 title 칸만 꺼낸다.
 */
function approvalTitle(trace: TraceEvent[], n: number): string | undefined {
  const waits = trace.filter((e) => e.kind === 'approval_waiting');
  const m = waits[n]?.detail?.match(/"title":\s*"((?:[^"\\]|\\.)*)"/);
  return m?.[1];
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [s, setS] = useState<RunDetail | null>(null);
  /** 발행 게이트 상태. 게이트 구역 · [ CARDS ] · [ DECIDED BY HUMAN ] 이 함께 본다 (D42). */
  const pub = usePublish(id, true, s?.status);
  /** 불러오지 못한 이유. null 이면 아직 시도 중이거나 정상이다. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [view, setView] = useState<'card' | 'raw'>('card');
  const [showLog, setShowLog] = useState(true);
  const [meter, setMeter] = useState<'budget' | 'usage'>('budget');
  const [gate, setGate] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tool' | 'think' | 'err'>('all');
  const [page, setPage] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 미리보기 모달이 보고 있는 카드 순번. null 이면 닫힌 상태다. */
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeX = useRef<number | null>(null);

  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < NARROW);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const poll = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch(`/api/runs/${id}`, { cache: 'no-store' });
    } catch {
      // 서버가 죽었거나 연결이 끊겼다. 계속 도는 대신 멈추고 알린다.
      setLoadError('서버에 연결하지 못했다. 개발 서버가 떠 있는지 확인한다.');
      return;
    }
    if (!res.ok) {
      // 404 를 그냥 넘기면 화면이 «불러오는 중» 에서 영원히 멈춘다 —
      // CLI 로 돌린 실행처럼 ui-state.json 이 없는 폴더에서 실제로 그랬다.
      setLoadError(res.status === 404
        ? '이 실행의 화면 상태가 없다. CLI 로 돌린 실행은 화면 상태(ui-state.json)를 남기지 않는다.'
        : `실행 상태를 불러오지 못했다 (HTTP ${res.status})`);
      return;
    }
    setLoadError(null);
    const next = await res.json() as RunDetail;
    setS(next);
    // 끝난 실행은 더 두드리지 않는다.
    if (!TERMINAL_STATUSES.has(next.status)) timer.current = setTimeout(() => void poll(), POLL_MS);
  }, [id]);

  useEffect(() => {
    void poll();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [poll]);

  /** 카드뉴스 굽기. 사람이 눌렀을 때만 돈다. */
  async function exportCards() {
    setBusy(true); setConflict(null);
    const res = await fetch(`/api/runs/${id}/export`, { method: 'POST' }).catch(() => null);
    if (!res) {
      setConflict({ code: 'network', message: NETWORK_ERR });
      setBusy(false);
      return;
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { error?: string; message?: string };
      setConflict({ code: b.error ?? String(res.status), message: b.message ?? '내보내지 못했다' });
    }
    setBusy(false);
    await poll();
  }

  async function post(path: string, body: unknown) {
    setBusy(true); setConflict(null);
    const res = await fetch(`/api/runs/${id}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    // 서버에 닿지 못하면 답·승인 버튼이 잠긴 채 남지 않게 푼다.
    if (!res) {
      setConflict({ code: 'network', message: NETWORK_ERR });
      setBusy(false);
      return;
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { error?: string; message?: string };
      setConflict({ code: b.error ?? String(res.status), message: b.message ?? '요청이 거절됐다' });
    }
    setBusy(false);
    await poll();
  }

  // 최신이 위로 온다. 실행이 길어지면 방금 무슨 일이 있었는지가 먼저 보여야 한다.
  const shown = useMemo(
    () => (s
      ? s.trace.filter((e) => filter === 'all' || glyph(e).group === filter).reverse()
      : []),
    [s, filter],
  );
  const pageCount = Math.max(1, Math.ceil(shown.length / LOG_PAGE));
  // 거르고 나서 쪽이 줄면 빈 쪽에 남을 수 있다. 그때는 마지막 쪽으로 당긴다.
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = shown.slice(safePage * LOG_PAGE, safePage * LOG_PAGE + LOG_PAGE);
  const counts = useMemo(() => {
    const c = { tool: 0, think: 0, err: 0 };
    for (const e of s?.trace ?? []) c[glyph(e).group] += 1;
    return c;
  }, [s]);

  if (loadError) {
    return (
      <main>
        <div className="win">
          <div className="titlebar">
            <div className="row" style={{ gap: 12 }}>
              <Lights />
              <span className="mut">ops-brief</span><span className="fnt">-</span>
              <span className="ink">run/{id}</span>
            </div>
            <Link href="/" className="mut" style={{ fontSize: 11 }}>cd ..</Link>
          </div>
          <div className="strip warn" style={{ borderBottom: 'none' }}>
            <div><span className="wrn">✕</span> <b>불러오지 못했다</b></div>
            <div className="mut">{loadError}</div>
          </div>
        </div>
      </main>
    );
  }
  if (!s) return <main><span className="mut">불러오는 중<Cursor /></span></main>;

  const dead = !s.live;
  const askable = Boolean(s.pending_question) && s.live;
  const approvable = Boolean(s.pending_approval) && s.live;
  // 엔진이 잰 값이 있으면 그것을 쓴다. updated_at 은 실행이 끝난 뒤에도
  // 카드 내보내기 같은 작업으로 갱신돼, 끝난 실행의 경과 시간이 계속 늘어난다.
  const elapsed = s.elapsed_seconds
    ?? (Date.parse(s.updated_at) - Date.parse(s.created_at)) / 1000;
  const toolCalls = s.trace.filter((e) => e.kind === 'tool_use').length;
  const u = s.usage;
  // 상한이 재는 것은 «캐시 읽기를 뺀» 입력이다 (agent/src/usage.ts 의 freshInputTokens).
  // 캐시 읽기까지 더하면 상한을 한참 넘겨 보인다 — 실제 실행에서 겪은 함정이다.
  const freshInput = u && u.usage_known
    ? u.input_tokens + u.cache_creation_input_tokens
    : null;
  const known = Boolean(u?.usage_known);
  const lim = s.limits;

  const bottomCols = narrow || !showLog ? 'minmax(0,1fr)' : 'minmax(0,1fr) 372px';

  return (
    <main>
      <div className="win">

        {/* ─────────────────────────── 타이틀 바 */}
        <div className="titlebar">
          <div className="row" style={{ gap: 12 }}>
            <Lights />
            <span className="mut">ops-brief</span><span className="fnt">-</span>
            <span className="ink">run/{s.run_id}</span>
            <span className="fnt">·</span>
            <span className="mut">{s.fixture_id ?? 'live'}</span>
            <Link href="/" className="mut" style={{ fontSize: 11 }}>cd ..</Link>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <StatusBadge status={s.status} pendingApproval={Boolean(s.pending_approval)} />
            <div className="tabs">
              <button className="tab" aria-pressed={view === 'card'} onClick={() => setView('card')}>--cards</button>
              <button className="tab" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>--raw</button>
            </div>
            <button onClick={() => setShowLog((v) => !v)}>{showLog ? '--no-log' : '--log'}</button>
          </div>
        </div>

        {/* ─────────────────────────── 프롬프트 헤더 */}
        <div style={{ padding: '16px 18px 14px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            <div>
              <span className="ok">➜</span> <span className="mut">brief</span> run
              {s.fixture_id && <> --fixture <span className="ink">{s.fixture_id}</span></>}
              {s.period && <>
                {' '}--since <span className="ink">{s.period.since}</span>
                {' '}--until <span className="ink">{s.period.until}</span>
              </>}
              {' '}--axis <span className="ok">{s.focus || 'auto'}</span>
              {' '}--engine <span className="ink">{s.engine ?? 'claude'}</span>
            </div>
            <div className="mut">
              auth: {credLine(s.credential_source)} · engine {s.engine ?? 'claude'}
              {/* 설명은 툴팁으로 내린다 — 값만 남긴다. 머리줄 모드 배지와 같은 규칙이다. */}
              {' · '}live{' '}
              {s.fixture_id
                ? <span className="wrn" data-tip="외부 API 를 부르지 않았다 · 스냅샷을 읽었다."
                    tabIndex={0}>false</span>
                : <span className="ok" data-tip="실제 API 를 불렀다." tabIndex={0}>true</span>}
              {!dead && <Cursor />}
            </div>
          </div>
          <div className="row" style={{ marginTop: 13, fontSize: 11, gap: 10 }}>
            {/*
              여기 있던 「live true — 이 서버가 실행 중」을 뺐다. 윗줄의 live 표시와
              같은 낱말이 뜻만 다르게 두 번 나와 읽는 사람을 헷갈리게 했다.
              뺀 뜻은 사라지지 않는다 — 이 서버가 들고 있지 않은 실행은
              store.read() 가 곧바로 interrupted 로 바꾸므로 상태 배지와 중단 패널이 말한다.
            */}
            {/* 언제 만든 브리핑인지. 목록에서 넘어오면 잊기 쉽다. */}
            <span className="mut">
              created <span className="ink">{stamp(s.created_at)}</span>
              {s.period && <> · period <span className="ink">{s.period.since} ~ {s.period.until}</span></>}
              {!s.period && <span className="fnt"> · period 기록 없음</span>}
            </span>
          </div>
        </div>

        {/* ─────────────────────────── 계기 3분할 */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0,1fr)' : 'minmax(0,30fr) minmax(0,35fr) minmax(0,35fr)',
          borderBottom: '1px solid var(--line)',
        }}>
          {/* PROGRESS */}
          <div className="pane">
            <SectionHead label={`[ PROGRESS ] elapsed ${clock(elapsed)}`} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12 }}>
              {s.steps.map((st) => {
                const m = STEP_MARK[st.state];
                return (
                  <div key={st.label} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: 8 }}>
                    <span className={m.cls}>{m.g}</span>
                    <span className={st.state === 'current' ? 'ink' : 'mut'}>{st.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* AXES */}
          <div className="pane">
            <SectionHead label="[ AXES ]" />
            {s.axes.collected ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10, fontSize: 12 }}>
                  {s.axes.tiles.map((t) => (
                    <div className="tile" key={t.key}>
                      <div className="mut">
                        {t.key === 'dev' && s.links.repo
                          ? <Out href={`https://github.com/${s.links.repo}/issues`}
                              title={s.links.repo}>dev ↗</Out>
                          : t.key}
                      </div>
                      <div className="stat">
                        <span className="v">{t.value === null ? '-' : t.value}</span>{' '}
                        <span className={t.tone === 'mut' ? 'mut' : t.tone} style={{ fontSize: 11 }}>{t.note}</span>
                        {t.alert ? <span className={t.alert.tone} style={{ fontSize: 11 }}> · {t.alert.text}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="note" style={{ marginTop: 11 }}>
                  unavailable_fields:{' '}
                  {s.axes.unavailable_fields.length === 0
                    ? <><span className="ok">[]</span> - 네 축 모두 값을 받았다</>
                    : <><span className="wrn">[{s.axes.unavailable_fields.join(', ')}]</span> - 조회하지 못했다. 0 이 아니다</>}
                </div>
                {/*
                  검색 출처는 카드가 인용하지 않아도 여기 남긴다.
                  트렌드 축의 «N hit» 이 어디서 왔는지 주소로 확인할 수 있어야 한다.
                */}
                {s.links.web.length > 0 && (
                  <details className="fold note" style={{ marginTop: 8 }}>
                    <summary>
                      <span className="ok">출처</span>
                      <span className="ink">{s.links.web.length}</span>
                    </summary>
                    <div style={{ marginTop: 6 }}>
                      {s.links.web.map((w, i) => (
                        <div key={w.url} style={{ marginTop: i === 0 ? 0 : 4 }}>
                          <Out href={w.url} title={w.url}>{w.title}</Out>
                          {w.published_at
                            ? <span className="fnt"> · {w.published_at}</span>
                            : <span className="wrn"> · 게시일 미확인</span>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <div className="note">아직 도구를 부르지 않았다 - 네 축 값이 없다.</div>
            )}
          </div>

          {/* BUDGET ↔ USAGE */}
          <div
            className="pane"
            style={{ touchAction: 'pan-y' }}
            onPointerDown={(e) => { swipeX.current = e.clientX; }}
            onPointerUp={(e) => {
              if (swipeX.current !== null && Math.abs(e.clientX - swipeX.current) > 36) {
                setMeter((p) => (p === 'budget' ? 'usage' : 'budget'));
              }
              swipeX.current = null;
            }}
          >
            <SectionHead
              label={meter === 'budget'
                ? '[ BUDGET ] limits'
                : known ? '[ USAGE ] cost_is_estimate: true' : '[ USAGE ] usage_known: false'}
              hint={meter === 'budget' && lim
                ? `반복 ${lim.maxTurns}회 상한은 SDK 가 검사한다 - 이 화면은 실제 턴 수를 관측할 수 없어 게이지로 그리지 않는다`
                : undefined}
              right={
                <span className="row" style={{ gap: 6 }}>
                  <button className="dot" title="BUDGET" aria-pressed={meter === 'budget'} onClick={() => setMeter('budget')} />
                  <button className="dot" title="USAGE" aria-pressed={meter === 'usage'} onClick={() => setMeter('usage')} />
                </span>
              }
            />
            {meter === 'budget' ? (
              lim ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9, fontSize: 11.5 }}>
                  {/* 단서는 문단이 아니라 각 줄의 툴팁에 둔다 (마우스를 올리면 나온다). */}
                  <Gauge label="cost (est)" value={known && u ? u.total_cost_usd : null}
                    max={lim.maxBudgetUsd} prefix="$" digits={2} tone="ok"
                    hint="SDK 로컬 추정값 · 종료 조건 판정용. 실제 청구액이 아니다" />
                  <Gauge label="tool calls" value={toolCalls} max={lim.maxToolCalls}
                    hint="이 실행이 부른 도구 수. 상한에 닿으면 stopped 로 멈춘다" />
                  <Gauge label="fresh input" value={freshInput} max={lim.maxInputTokens}
                    hint="캐시 읽기를 뺀 입력 토큰 · 상한이 재는 값이다" />
                  <Gauge label="wall clock" value={Math.round(elapsed)} max={lim.maxElapsedSeconds} unit="s"
                    hint="엔진이 잰 실행 시간 · 사람을 기다린 시간은 빠져 있다" />
                </div>
              ) : <div className="note">상한이 기록되지 않았다 - 이 실행은 상한을 남기기 전 버전이다.</div>
            ) : (
              known && u ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10 }}>
                    <div className="stat"><div className="k">input</div><div className="v">{u.input_tokens.toLocaleString()}</div></div>
                    <div className="stat"><div className="k">cache read</div><div className="v">{u.cache_read_input_tokens.toLocaleString()}</div></div>
                    <div className="stat"><div className="k">output</div><div className="v">{u.output_tokens.toLocaleString()}</div></div>
                    <div className="stat"><div className="k">cost (est)</div><div className="v">${u.total_cost_usd.toFixed(4)}</div></div>
                  </div>
                  <div className="note">
                    <span data-tip="SDK 가 번들된 단가표로 로컬 계산한다. 단가 변경·모델 미인식에서 실제 청구와 어긋날 수 있다"
                      aria-label="cost 는 SDK 가 번들된 단가표로 로컬 계산한 추정값이다">
                      cost 는 <span className="ink">추정값</span>이다
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <div style={{ border: '1px solid var(--warn)', padding: '11px 13px' }}>
                    <div className="k mut" style={{ fontSize: 11 }}>토큰 · 비용</div>
                    <div className="wrn" style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.5 }}>확인 못 함</div>
                  </div>
                  <div className="note">
                    {u?.unknown_reason ?? '아직 집계되지 않았다.'}{' '}
                    토큰은 이미 썼으므로 <span className="ink">0 으로 적지 않는다.</span>
                    {u && u.cache_read_input_tokens > 0 && <>
                      <br />아는 값: 캐시 읽기 <span className="ink">{u.cache_read_input_tokens.toLocaleString()}</span> 토큰
                    </>}
                  </div>
                </div>
              )
            )}
            <div className="note" style={{ color: 'var(--faint)', marginTop: 11 }}>
              ← 옆으로 밀어 {meter === 'budget' ? 'USAGE' : 'BUDGET'} 보기
            </div>
          </div>
        </div>

        {/* ─────────────────────────── 서버가 거절한 요청 */}
        {conflict && (
          <div className="strip warn" style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <span className="wrn">✕</span>
            <div style={{ minWidth: 0 }}>
              <div><b>요청이 거절됐다</b> - <span className="wrn">{conflict.code}</span> <span className="mut">HTTP 409</span></div>
              <div className="mut">{conflict.message}</div>
            </div>
            <button style={{ marginLeft: 'auto' }} onClick={() => setConflict(null)}>dismiss</button>
          </div>
        )}

        {/* ─────────────────────────── 승인 게이트 */}
        {approvable && s.pending_approval && (
          <div className="strip bad">
            <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <div>
                  <span className="bad">!</span> <b>write tool 승인 대기</b>{' '}
                  <span className="bad">{s.pending_approval.tool}</span>{' '}
                  <span className="mut">v{s.pending_approval.version}</span>
                </div>
                {summaryLines(s.pending_approval.summary).map(([k, v]) => (
                  <div className="mut" key={k}>
                    {k}{' '}
                    {k === 'repo' && /^[\w.-]+\/[\w.-]+$/.test(v)
                      ? <Out href={`https://github.com/${v}`}>{v} ↗</Out>
                      : <span className="ink">{v}</span>}
                  </div>
                ))}
                <div className="mut">
                  승인하면 <span className="ink">1회용 토큰</span>을 주입해 실행한다 - 모델은 토큰을 받지 않는다
                </div>
                {/*
                  픽스처 실행은 simulated 로 끝나지만 live 는 실제 저장소를 바꾼다.
                  같은 버튼이 두 가지 다른 결과를 내므로, 어느 쪽인지 승인 **전에** 말한다.
                */}
                {s.fixture_id === null ? (
                  <div className="bad">
                    ⚠ live 모드다 - 승인하면{' '}
                    {s.links.repo
                      ? <Out href={`https://github.com/${s.links.repo}/issues`}>{s.links.repo}</Out>
                      : '실제 저장소'}
                    {' '}에 <b>진짜 이슈가 만들어진다.</b> 되돌리려면 revert_issue 로 닫아야 한다
                  </div>
                ) : (
                  <div className="mut">
                    fixture 모드다 - 승인해도 <span className="ink">실제 이슈는 만들어지지 않는다</span>
                    {' '}(<span className="fnt">simulated</span>)
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button onClick={() => setGate((v) => !v)}>--diff</button>
                <button className="primary" disabled={busy} onClick={() => void post('approvals', {
                  approval_id: s.pending_approval!.approval_id,
                  version: s.pending_approval!.version, approved: true,
                })}>approve</button>
                <button className="danger" disabled={busy} onClick={() => void post('approvals', {
                  approval_id: s.pending_approval!.approval_id,
                  version: s.pending_approval!.version, approved: false, reason: '화면에서 거절',
                })}>reject</button>
              </div>
            </div>
            {gate && <pre style={{ marginTop: 12 }}>{JSON.stringify(s.pending_approval.summary, null, 2)}</pre>}
          </div>
        )}

        {/* ─────────────────────────── 발행 게이트 — 끝난 실행, 그리고 다시 판정하러 다시 도는 실행 (D37) */}
        {(s.status === 'done' || s.live) && <PublishGate ctl={pub} runId={s.run_id} />}

        {/* ─────────────────────────── 질문 게이트 */}
        {askable && s.pending_question && (
          <QuestionGate q={s.pending_question} busy={busy}
            onSubmit={(answers) => void post('answers', {
              question_id: s.pending_question!.question_id,
              version: s.pending_question!.version,
              answers,
            })} />
        )}

        {/* ─────────────────────────── 중단 — 콜백 소실 */}
        {s.status === 'interrupted' && (
          <div style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="strip warn">
              <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <div><span className="wrn">■</span> <b>중단됨</b> <span className="mut">이 서버가 이 실행을 들고 있지 않다</span></div>
                  <div className="mut">
                    서버를 재시작해 메모리에서 기다리던 <span className="ink">canUseTool</span> 콜백이 사라졌다.
                    상태만 고쳐도 작업은 이어지지 않는다.
                  </div>
                  <div className="mut">session_id <span className="ink">{s.session_id ?? '없음'}</span></div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="primary" disabled={busy || !s.session_id}
                    title={s.session_id ? '' : '이어갈 세션 ID 가 없다'}
                    onClick={() => void post('resume', { mode: 'resume' })}>--resume</button>
                  <button disabled={busy} style={{ fontSize: 12.5, fontWeight: 600, padding: '8px 14px' }}
                    onClick={() => void post('resume', { mode: 'retry' })}>--retry</button>
                </div>
              </div>
            </div>
            {(s.pending_question || s.pending_approval) && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: narrow ? 'minmax(0,1fr)' : 'repeat(auto-fit,minmax(300px,1fr))',
                borderBottom: '1px solid var(--line-in)',
              }}>
                {s.pending_question && (
                  <div className="pane">
                    <SectionHead label="[ STALE QUESTION ] 무효" tone="mut" />
                    <div className="note">
                      이 질문을 기다리던 콜백이 사라졌다. 지금 답해도 작업은 이어지지 않는다 - 재개하면 에이전트가 다시 묻는다.
                    </div>
                    <pre style={{ marginTop: 9, color: 'var(--faint)' }}>
                      {s.pending_question.question_id} v{s.pending_question.version}
                      {'\n'}{s.pending_question.questions.map((q) => q.question).join('\n')}
                    </pre>
                  </div>
                )}
                {s.pending_approval && (
                  <div className="pane">
                    <SectionHead label="[ STALE APPROVAL ] 무효" tone="mut" />
                    <div className="note">
                      {s.pending_approval.tool} - 승인 토큰은 <span className="ink">발급되지 않았다</span>. 지금 승인해도 실행되지 않는다.
                    </div>
                    <div style={{ marginTop: 9, fontSize: 11.5, lineHeight: 1.8 }}>
                      <div className="fnt">무엇을 쓰려 했는지</div>
                      {summaryLines(s.pending_approval.summary).map(([k, v]) => (
                        <div className="mut" key={k}>{k} <span style={{ color: 'var(--faint)' }}>{v}</span></div>
                      ))}
                      <details style={{ marginTop: 7 }}>
                        <summary className="fnt">원문 펼쳐 보기</summary>
                        <pre style={{ marginTop: 6, color: 'var(--faint)' }}>
                          {JSON.stringify(s.pending_approval.summary, null, 2)}
                        </pre>
                      </details>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─────────────────────────── 종료 조건 */}
        {s.stop_reason && (
          <div className="strip warn">
            <div>
              <span className="wrn">■</span> <b>종료 조건에 걸려 멈췄다</b>{' '}
              <span className="wrn">{s.stop_reason.limit}</span>
            </div>
            <div className="mut">
              {s.stop_reason.message} - 관측 <span className="ink">{s.stop_reason.observed}</span>
              {' '}/ 허용 <span className="ink">{s.stop_reason.allowed}</span>. 지금까지의 결과는 아래에 보존된다.
            </div>
            <div className="mut">
              모델의 「다 했다」 한 마디를 <span className="ink">done</span> 으로 처리하지 않는다 -
              이 실행의 상태는 <span className="wrn">stopped</span> 다.
            </div>
          </div>
        )}

        {/* ─────────────────────────── 사람이 결정한 것 */}
        <div style={{ borderBottom: '1px solid var(--line)' }}>
          <div style={{ padding: '14px 18px' }}>
            <SectionHead label={`[ DECIDED BY HUMAN ] ${s.answered.length + s.decisions.length + (pub.view?.publish.decisions.length ?? 0)}`} />
            {s.answered.length + s.decisions.length + (pub.view?.publish.decisions.length ?? 0) === 0 ? (
              <div className="note">
                아직 없다 - 답과 승인이 여기 쌓인다. 같은 질문을 다시 묻지 않기 위한 기록이다.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                {s.answered.map((a) => (
                  <div className="spread" key={a.question_id}
                    style={{ padding: '7px 0', borderBottom: '1px solid var(--line-faint)', gap: 16 }}>
                    <span className="mut" style={{ minWidth: 0 }}>
                      answer · <span className="ink">{(a.headers ?? []).join(' · ') || 'question'}</span>{' '}
                      <span className="fnt">{a.question_id}</span>
                    </span>
                    <span className="ok" style={{ textAlign: 'right' }}>{Object.values(a.answers).join(' · ')}</span>
                  </div>
                ))}
                {s.decisions.map((d, i) => {
                  // 승인 기록은 순서대로 쌓이므로, n 번째 승인이 n 번째로 만들어진 이슈다.
                  const madeSoFar = s.decisions.slice(0, i + 1).filter((x) => x.approved).length;
                  const made = d.approved ? s.links.created[madeSoFar - 1] : undefined;
                  return (
                    <div className="spread" key={d.approval_id}
                      style={{ padding: '7px 0', borderBottom: '1px solid var(--line-faint)', gap: 16 }}>
                      <span className="mut" style={{ minWidth: 0 }}>
                        {d.tool.replace(/^mcp__ops__/, '')} <span className="fnt">{d.approval_id}</span>
                        {(() => {
                          // 제목은 새 기록에는 결정에 함께 남고, 예전 기록은 승인 대기 로그의 입력에서 찾는다.
                          const t = d.title ?? approvalTitle(s.trace, i);
                          return t ? <div className="ink" style={{ fontSize: 11.5 }}>「{t}」</div> : null;
                        })()}
                      </span>
                      <span className={d.approved ? 'ok' : 'bad'} style={{ textAlign: 'right' }}>
                        {d.approved ? 'approved - 토큰 주입해 실행' : `rejected - ${d.reason ?? '사람이 승인하지 않았다'}`}
                        {made && (made.url
                          ? <> · <Out href={made.url}>#{made.number} ↗</Out></>
                          : <> · <span className="wrn" title="fixture 모드다. 실제 이슈는 만들어지지 않았다">
                              #{made.number} (시뮬레이션)</span></>)}
                      </span>
                    </div>
                  );
                })}
                <PublishDecisions view={pub.view} />
              </div>
            )}
            <div className="note" style={{ marginTop: 10 }}>
              되돌리기(revert_issue)의 대상 범위는 이 기록이 정한다 · 같은 승인을 두 번 제출해도 이슈는 한 번만 만들어진다
            </div>
          </div>
        </div>

        {/* ─────────────────────────── 본문 2단 */}
        <div style={{ display: 'grid', gridTemplateColumns: bottomCols }}>
          <div style={{ padding: 18, minWidth: 0 }}>
            {view === 'card' ? (
              <CardsPane cards={s.cards} charts={s.charts} runId={s.run_id}
                gate={pub.view ? {
                  related: pub.related,
                  edited: new Map(pub.view.publish.edits.map((e) => [e.card_no, e])),
                  editing: pub.mode === 'edit',
                  drafts: pub.drafts,
                  onDraft: pub.setDraft,
                } : undefined}
                links={s.links} exports={s.exports}
                exporting={s.cards_exporting === true} busy={busy} onExport={() => void exportCards()}
                onPreview={(at) => setPreviewAt(at)} />
            ) : (
              <div style={{ border: '1px solid var(--line)', background: 'var(--raised)' }}>
                <div className="spread" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', fontSize: 11.5 }}>
                  <span className="ok">cat draft.md</span>
                  <button disabled={!s.final_text} onClick={() => {
                    void navigator.clipboard?.writeText(s.final_text ?? '');
                    setCopied(true); setTimeout(() => setCopied(false), 1500);
                  }}>{copied ? 'copied' : 'copy'}</button>
                </div>
                <pre style={{ border: 'none', padding: 16, background: 'transparent', color: 'var(--prose)', fontSize: 12.5 }}>
                  {s.final_text ?? '아직 원고가 없다. 실행이 끝나면 여기에 전문이 남는다.'}
                </pre>
              </div>
            )}
          </div>

          {showLog && (
            <div className="log">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, marginBottom: 12 }}>
                <span className="sechead">
                  [ TAIL -F ] {s.trace.length} <span className="mut">· latest</span>
                </span>
                <span className={dead ? 'mut' : 'ok'}>
                  {dead ? '○ poll 정지 - 끝난 실행은 더 두드리지 않는다' : `● poll ${POLL_MS / 1000}s`}
                </span>
              </div>
              <div className="row" style={{ gap: 5, marginBottom: 12 }}>
                {(['all', 'tool', 'think', 'err'] as const).map((f) => (
                  <button className="chip" key={f} aria-pressed={filter === f}
                    onClick={() => { setFilter(f); setPage(0); }}
                    style={f === 'err' && counts.err > 0
                      ? { borderColor: 'rgba(226,96,75,.45)', color: 'var(--danger-ink)' } : undefined}>
                    {f}{f === 'all' ? '' : ` ${counts[f]}`}
                  </button>
                ))}
              </div>
              {/* 최신이 위라서 프롬프트도 위에 둔다 — 커서가 가장 최근 줄 바로 앞에 온다. */}
              <div className="ok" style={{ paddingBottom: 9 }}>➜{!dead && <Cursor />}</div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {pageItems.map((e) => {
                  const g = glyph(e);
                  return (
                    <div className="line" key={e.seq}>
                      <span className="when">{hhmmss(e.at)}</span>
                      <span className={g.cls}>{g.mark}</span>
                      <div style={{ minWidth: 0 }}>
                        <span className={e.isError ? 'bad' : 'ink'}>{e.label}</span>
                        {e.detail && (
                          <details>
                            <summary className="sub" style={{ fontSize: 11 }}>펼쳐 보기</summary>
                            <pre style={{ marginTop: 6 }}>{e.detail}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
                {shown.length === 0 && <div className="note">이 갈래에 해당하는 기록이 없다.</div>}
              </div>

              {shown.length > LOG_PAGE && (
                <div className="spread" style={{ marginTop: 12, alignItems: 'center' }}>
                  <button className="chip" disabled={safePage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ newer</button>
                  <span className="note">
                    {safePage * LOG_PAGE + 1}–{safePage * LOG_PAGE + pageItems.length}
                    {' / '}{shown.length}
                    <span className="fnt"> · {safePage + 1}/{pageCount}</span>
                  </span>
                  <button className="chip" disabled={safePage >= pageCount - 1}
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>older ›</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {previewAt !== null && s.exports.png.length > 0 && (
        <CardModal runId={s.run_id} pages={s.exports.png} at={previewAt}
          onMove={setPreviewAt} onClose={() => setPreviewAt(null)} />
      )}
    </main>
  );
}
