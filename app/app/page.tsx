'use client';

/**
 * 홈 — 터미널 화면.
 *
 * 왼쪽 [ RUNS ] 는 지난 실행을 결과 한 줄과 비용까지 함께 보여준다.
 * 오른쪽 [ NEW RUN ] · [ PRESETS ] · [ SAVED ] 는 새 실행을 거는 자리다.
 *
 * 비용을 모르는 실행은 «확인 못 함» 으로 그린다 — 0 으로 적으면 거짓 보고가 된다.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SectionHead, StatusBadge } from '@/components/term';
import { PublishQueueLink } from '@/components/publish-queue';
import type { RunLimits, RunRow } from '@/lib/types';

type Listing = {
  runs: RunRow[];
  fixtures: { id: string; label: string }[];
  credential_source: 'api_key' | 'auth_token' | 'stored_login';
  limits: RunLimits;
  mode: 'fixture' | 'live';
  live_writes: boolean;
  allowed_repos: string[];
};

type Range = '7d' | '15d' | 'custom';

const DAY = 86_400_000;
/** 목록 한 쪽에 보일 실행 수. 로그 열과 같은 수로 맞춘다 — 두 쪽 넘기개가 같게 움직인다. */
const RUNS_PAGE = 10;
/**
 * 달력 날짜. **현지 기준이다.**
 *
 * toISOString() 은 UTC 로 자른다 — 한국에서 아침에 열면 어제 날짜가 나왔다.
 * 사람이 고르는 것은 자기 달력의 날짜이므로 현지 기준으로 만든다.
 */
const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const daysAgo = (n: number) => iso(new Date(Date.now() - n * DAY));

/** 목록에 쓰는 짧은 시각. 초까지는 필요 없다. */
function stamp(v: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Favorite = {
  id: string; fixture_id: string; focus: string; created_at: string;
};

/** 픽스처 4종을 요청 프리셋으로 푼 추천 목록. 직접 입력 없이 한 번에 시작한다. */
const PRESETS: { fixture: string; name: string; desc: string; focus: string }[] = [
  { fixture: 'f1-normal', name: '평범한 주간 점검',
    desc: '문제가 없을 때 없다고 말하는지 - 억지 진단 경계', focus: '' },
  { fixture: 'f2-deploy-fail', name: '배포 실패 추적',
    desc: '빌드 오류 원문과 복구 여부 · 축 system', focus: '시스템' },
  { fixture: 'f3-metric-drop', name: '지표 급감 살펴보기',
    desc: '추이는 보되 원인은 단정하지 않는지', focus: '사용자' },
  { fixture: 'f4-sparse', name: '자료 부족 브리핑',
    desc: '결측과 0 을 구별하는지 · 카드 수를 억지로 안 채우는지', focus: '' },
];

const FAV_KEY = 'ops-briefing-favorites';
const NARROW = 1080;

function loadFavorites(): Favorite[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) as Favorite[] : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export default function Home() {
  const [data, setData] = useState<Listing | null>(null);
  const [fixture, setFixture] = useState('f2-deploy-fail');
  const [focus, setFocus] = useState('');
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [range, setRange] = useState<Range>('7d');
  const [since, setSince] = useState(daysAgo(7));
  const [until, setUntil] = useState(iso(new Date()));
  /** 두 번 눌러야 지운다. 첫 번째 누름을 여기 담아 둔다. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < NARROW);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    setFavorites(loadFavorites());
    fetch('/api/runs').then((r) => r.json()).then((d: Listing) => {
      setData(d);
      if (d.fixtures.length && !d.fixtures.some((f) => f.id === fixture)) setFixture(d.fixtures[0]!.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveFavorites(next: Favorite[]) {
    setFavorites(next);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* 저장 실패는 무시 */ }
  }

  /** 고른 기간. 프리셋은 누를 때마다 «지금» 기준으로 다시 계산한다. */
  function period(): { since: string; until: string } {
    if (range === '7d') return { since: daysAgo(7), until: iso(new Date()) };
    if (range === '15d') return { since: daysAgo(15), until: iso(new Date()) };
    return { since, until };
  }

  async function startRun(opts: { fixture_id: string; focus?: string }) {
    const p = period();
    if (p.since >= p.until) { setError('기간이 뒤집혔다 - 시작이 끝보다 앞이어야 한다'); return; }
    setStarting(true); setError(null);
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // live 모드에서는 픽스처를 보내지 않는다. 보내면 실행 기록에 fixture_id 가 남아
        // 프롬프트 줄이 «--fixture ...» 로, 화면이 «fixture 모드» 로 잘못 말한다.
        fixture_id: live ? undefined : opts.fixture_id,
        focus: opts.focus || undefined,
        ...p,
      }),
    });
    const body = await res.json();
    if (!res.ok) { setError(body.message ?? body.error); setStarting(false); return; }
    location.href = `/runs/${body.run_id}`;
  }

  /** 실행을 지운다. 첫 누름은 확인, 두 번째 누름이 실제로 지운다. */
  async function removeRun(runId: string) {
    if (confirmDelete !== runId) {
      setConfirmDelete(runId);
      // 다른 데를 누르거나 시간이 지나면 확인 상태를 푼다 — 실수로 두 번 눌리지 않게.
      setTimeout(() => setConfirmDelete((c) => (c === runId ? null : c)), 4000);
      return;
    }
    setConfirmDelete(null); setError(null);
    const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { message?: string; error?: string };
      setError(b.message ?? b.error ?? '지우지 못했다');
      return;
    }
    const d = await fetch('/api/runs').then((r) => r.json()) as Listing;
    setData(d);
  }

  function addFavorite() {
    const fav: Favorite = {
      id: `fav-${Date.now().toString(36)}`,
      fixture_id: fixture, focus,
      created_at: new Date().toISOString(),
    };
    saveFavorites([fav, ...favorites].slice(0, 20));
  }

  const runs = data?.runs ?? [];
  // 목록 조회 기간. 기본은 최근 1주일 — [ NEW RUN ] 의 7d/15d/custom 과 같은 칩으로 고른다.
  const [runRange, setRunRange] = useState<'7d' | '30d' | 'all'>('7d');
  const rangeDays = runRange === '7d' ? 7 : runRange === '30d' ? 30 : null;
  const shownRuns = rangeDays === null
    ? runs
    : runs.filter((r) => {
      const t = Date.parse(r.created_at);
      return Number.isFinite(t) && t >= Date.now() - rangeDays * DAY;
    });
  const tally = {
    ok: shownRuns.filter((r) => r.status === 'done').length,
    halted: shownRuns.filter((r) => r.status === 'stopped' || r.status === 'interrupted').length,
    failed: shownRuns.filter((r) => r.status === 'failed').length,
  };
  // 지우거나 새 실행이 생겨 목록이 짧아지면 빈 쪽에 머무를 수 있다. 마지막 쪽으로 당긴다.
  const pageCount = Math.max(1, Math.ceil(shownRuns.length / RUNS_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRuns = shownRuns.slice(safePage * RUNS_PAGE, safePage * RUNS_PAGE + RUNS_PAGE);

  // 삭제는 제 열을 갖는다 — 비용 아래에 얹으면 어느 쪽 숫자인지 헷갈린다.
  const rowCols = narrow ? 'minmax(0,1fr) auto' : '250px 160px minmax(0,260px) 88px 62px';
  const lim = data?.limits;
  const live = data?.mode === 'live';

  return (
    <main>
      <div className="spread" style={{ marginBottom: 9, alignItems: 'center' }}>
        <span className="sechead" style={{ letterSpacing: '.16em', color: 'var(--muted)' }}>
          [ HOME ]
        </span>
        <span className="row" style={{ gap: 14 }}>
          <PublishQueueLink />
          <ModeBadge data={data} />
        </span>
      </div>

      <div className="win" style={{ padding: '20px 22px' }}>
        <div style={{ paddingBottom: 16, borderBottom: '1px solid var(--line)' }}>
          <h1 className="prose" style={{ fontSize: 22, color: 'var(--ink)' }}>
            「이미 있어」 주간 운영 브리핑
          </h1>
          <p className="prose" style={{ fontSize: 13.5, lineHeight: 1.7, margin: '7px 0 0' }}>
            시스템 · 사용자 · 개발 활동 · IT 트렌드 카드뉴스
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0,1fr)' : 'minmax(0,1fr) 300px',
          gap: 26, paddingTop: 18, alignItems: 'start',
        }}>

          {/* ─────────────────────── [ RUNS ] */}
          <div style={{ minWidth: 0 }}>
            {/* 셈 세 개에 상태 배지와 같은 색을 준다 - 표를 훑기 전에 결이 먼저 보인다. */}
            <SectionHead
              labelText={
                `[ RUNS ] ${shownRuns.length} · ok ${tally.ok} · halted ${tally.halted} · failed ${tally.failed}`
              }
              label={<>
                {`[ RUNS ] ${shownRuns.length} · `}
                <span className="ok">ok {tally.ok}</span>{' · '}
                <span className="wrn">halted {tally.halted}</span>{' · '}
                <span className="bad">failed {tally.failed}</span>
              </>}
              right={
                <span className="row" style={{ gap: 6 }}>
                  {([['7d', '최근 1주일'], ['30d', '최근 30일'], ['all', '전체 기간']] as const)
                    .map(([k, hint]) => (
                      <button className="seg" key={k} aria-pressed={runRange === k}
                        title={hint} onClick={() => { setRunRange(k); setPage(0); }}>
                        {k}
                      </button>
                    ))}
                </span>
              } />

            {!data && <div className="note">불러오는 중…</div>}
            {data && shownRuns.length === 0 && (
              <div className="note">
                {runs.length === 0
                  ? '아직 실행이 없다. 오른쪽에서 하나 걸어 본다.'
                  : '이 기간에 실행이 없다. 위에서 기간을 넓혀 본다.'}
              </div>
            )}

            {!narrow && runs.length > 0 && (
              <div style={{
                display: 'grid', gridTemplateColumns: rowCols, gap: 12, padding: '7px 0',
                borderBottom: '1px solid var(--line)',
                fontSize: 11, letterSpacing: '.1em', color: 'var(--muted)',
              }}>
                <span>RUN</span><span>STATUS</span><span>RESULT</span>
                <span style={{ textAlign: 'right' }}>COST</span>
                <span style={{ textAlign: 'right' }}>DEL</span>
              </div>
            )}

            {pageRuns.map((r) => {
              const cost = (
                <span className={r.cost === null ? 'wrn' : 'mut'}>
                  {r.cost === null ? '확인 못 함' : `$${r.cost.toFixed(2)}`}
                </span>
              );
              return (
                <div key={r.run_id} style={{
                  display: 'grid', gridTemplateColumns: rowCols, gap: 12, alignItems: 'center',
                  padding: '11px 0', borderBottom: '1px solid var(--line-faint)', fontSize: 12,
                }}>
                  <span style={{ minWidth: 0 }}>
                    <Link href={`/runs/${r.run_id}`}>
                      {r.focus ? r.focus : '--axis auto'}
                    </Link>
                    <br />
                    <span className="mut" style={{ fontSize: 11 }}>
                      {r.engine}{r.fixture_id ? ` · ${r.fixture_id}` : ' · live'} · {r.run_id}
                    </span>
                    <br />
                    <span className="fnt" style={{ fontSize: 10.5 }}>
                      created {stamp(r.created_at)}
                      {r.period && ` · period ${r.period.since} ~ ${r.period.until}`}
                    </span>
                  </span>
                  <span style={{ justifySelf: 'start' }}><StatusBadge status={r.status} /></span>
                  {narrow ? (
                    // 좁으면 결과와 비용을 한 줄로 묶는다.
                    // 4열 그대로 접으면 비용이 혼자 떨어져 어느 실행 것인지 읽히지 않는다.
                    <span style={{
                      gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between',
                      gap: 12, alignItems: 'baseline',
                    }}>
                      <span className="prose" style={{ fontSize: 12, color: 'var(--muted)' }}>{r.result}</span>
                      <span className="row" style={{ gap: 8 }}>
                        {cost}
                        <button className="chip" onClick={() => void removeRun(r.run_id)}
                          style={confirmDelete === r.run_id
                            ? { borderColor: 'var(--danger)', color: 'var(--danger-ink)' } : undefined}>
                          {confirmDelete === r.run_id ? '확인 - 한 번 더' : 'del'}
                        </button>
                      </span>
                    </span>
                  ) : (
                    <>
                      <span className="prose" style={{ fontSize: 12.5, color: 'var(--text)' }}>{r.result}</span>
                      <span style={{ textAlign: 'right' }}>{cost}</span>
                      <span style={{ textAlign: 'right' }}>
                        <button className="chip" onClick={() => void removeRun(r.run_id)}
                          title={confirmDelete === r.run_id ? '한 번 더 누르면 지운다' : '이 실행을 지운다'}
                          style={confirmDelete === r.run_id
                            ? { borderColor: 'var(--danger)', color: 'var(--danger-ink)' }
                            : undefined}>
                          {confirmDelete === r.run_id ? '확인' : 'del'}
                        </button>
                      </span>
                    </>
                  )}
                </div>
              );
            })}

            {shownRuns.length > RUNS_PAGE && (
              <div className="spread" style={{ marginTop: 12, alignItems: 'center' }}>
                <button className="chip" disabled={safePage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ newer</button>
                <span className="note">
                  {safePage * RUNS_PAGE + 1}-{safePage * RUNS_PAGE + pageRuns.length}
                  {' / '}{shownRuns.length}
                  <span className="fnt"> · {safePage + 1}/{pageCount}</span>
                </span>
                <button className="chip" disabled={safePage >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>older ›</button>
              </div>
            )}
          </div>

          {/* ─────────────────────── 사이드바 */}
          <div style={{ border: '1px solid var(--line)', background: 'var(--raised)', padding: 16 }}>
            <SectionHead label="[ NEW RUN ]" />

            <div className="note" style={{ marginBottom: 6 }}>--since / --until</div>
            <div className="row" style={{ gap: 6, marginBottom: 8 }}>
              {/*
                --since 의 7d/15d 처럼 **값**으로 적는다.
                디자인에서 버튼에 붙는 한글은 설명이지 이름이 아니다.
              */}
              {([['7d', '최근 1주일'], ['15d', '최근 15일'], ['custom', '날짜를 직접 고른다']] as const)
                .map(([k, hint]) => (
                  <button className="seg" key={k} aria-pressed={range === k}
                    title={hint} onClick={() => setRange(k)}>
                    {k}
                  </button>
                ))}
            </div>
            {range === 'custom' ? (
              <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'nowrap' }}
                title="브리핑이 다룰 기간을 직접 고른다">
                <input type="date" value={since} max={until}
                  onChange={(e) => setSince(e.target.value)} style={{ flex: 1 }} />
                <span className="fnt">~</span>
                <input type="date" value={until} min={since}
                  onChange={(e) => setUntil(e.target.value)} style={{ flex: 1 }} />
              </div>
            ) : (
              <div className="note" style={{ marginBottom: 14 }}>
                최근 {range === '7d' ? '1주일' : '15일'} ·{' '}
                {range === '7d' ? daysAgo(7) : daysAgo(15)} ~ {iso(new Date())}
                <span className="fnt"> · 시작할 때 다시 계산한다</span>
              </div>
            )}

            <div className="note" style={{ marginBottom: 6 }}>--axis</div>
            <input type="text" value={focus} onChange={(e) => setFocus(e.target.value)}
              placeholder="비우면 에이전트가 판단" style={{ marginBottom: 14 }} />

            <div className="note" style={{ marginBottom: 12 }}>
              --engine <span className="ink">claude</span> · Agent SDK · 자격증명은 <span className="ink">{credShort(data?.credential_source)}</span>
              <br />질문 대기 · 승인 게이트가 모두 돈다
            </div>

            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <button className="primary" style={{ flex: 1 }} disabled={starting}
                onClick={() => void startRun({ fixture_id: fixture, focus })}>
                brief run ↵
              </button>
              <button onClick={addFavorite} disabled={starting}
                style={{ padding: '10px 12px' }} title="지금 입력값을 즐겨찾기에 저장">★</button>
            </div>
            {error && <div className="note bad" style={{ marginTop: 8 }}>{error}</div>}

            <div className="note" style={{ margin: '14px 0 6px' }}>
              --fixture{live && <span className="fnt"> · live 모드에서는 쓰지 않는다</span>}
            </div>
            {/* live 에서는 고른 값을 그대로 두지 않는다 — 보내지 않을 값을 골라 둔 것처럼 보인다. */}
            <select value={live ? '' : fixture} disabled={live} onChange={(e) => setFixture(e.target.value)}>
              {live
                ? <option value="">— live 에서는 픽스처를 쓰지 않는다</option>
                : (data?.fixtures ?? []).map((f) => (
                  <option key={f.id} value={f.id}>{f.id} - {f.label}</option>
                ))}
            </select>
            <div className="note" style={{ marginTop: 9 }}>
              {lim && <>limits: iter {lim.maxTurns} · tool {lim.maxToolCalls} · ${lim.maxBudgetUsd} · {lim.maxElapsedSeconds}s<br /></>}
              {live
                ? <><span className="wrn">live 모드</span> · 실제 API 를 부른다. 픽스처 선택은 무시된다</>
                : <>fixture 모드 · 외부 API 호출 없음</>}
            </div>

            {/* PRESETS */}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
              <SectionHead label="[ PRESETS ]" />
              {live && (
                <div className="note fnt" style={{ marginBottom: 8 }}>
                  live 에서는 <span className="ink">--axis</span> 만 적용된다 - 픽스처 이름은 설명일 뿐이다
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, fontSize: 11.5 }}>
                {PRESETS.map((p) => (
                  <div key={p.fixture} style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'baseline',
                  }}>
                    <span>
                      <span className="ink">{p.fixture}</span>
                      <br /><span className="mut">{p.desc}</span>
                    </span>
                    <button className="chip" disabled={starting}
                      onClick={() => void startRun({ fixture_id: p.fixture, focus: p.focus })}>
                      run ↵
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* SAVED */}
            {favorites.length > 0 && (
              <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                <SectionHead label={`[ SAVED ] ${favorites.length}`} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9, fontSize: 11.5 }}>
                  {favorites.map((f) => (
                    <div key={f.id} style={{
                      display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 8, alignItems: 'baseline',
                    }}>
                      <span>
                        <span className="ink">{f.fixture_id} · {f.focus || '에이전트 판단'}</span>
                      </span>
                      <button className="chip" disabled={starting} onClick={() => void startRun({
                        fixture_id: f.fixture_id, focus: f.focus,
                      })}>run</button>
                      <button className="chip" onClick={() => saveFavorites(favorites.filter((x) => x.id !== f.id))}>
                        del
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * 지금 어느 모드로 도는가.
 *
 * 이 표시가 없으면 시작 화면만 보고는 알 수 없다 — 픽스처 선택칸이 있으니
 * 늘 픽스처인 줄 알기 쉽다. live 는 실제 저장소·실제 지표를 부르므로 눈에 띄어야 한다.
 */
function ModeBadge({ data }: { data: Listing | null }) {
  if (!data) return <span className="note">모드 확인 중…</span>;
  const live = data.mode === 'live';
  return (
    <span className="row" style={{ gap: 8, fontSize: 11 }}>
      {/* 설명은 툴팁으로 내린다 — 머리줄은 값만 남긴다. 뜻은 계기 게이지와 같은 규칙이다. */}
      {/* 켜져 있는 쪽을 초록으로 읽는다 — 배지는 「지금 무엇으로 도는가」를 말한다. */}
      <span className="badge" style={{ color: live ? 'var(--accent)' : 'var(--warn)' }}
        data-tip={live ? '실제 API 를 부른다.' : '외부 API 를 부르지 않는다 · 스냅샷을 읽는다.'}
        data-tip-below="" tabIndex={0}>
        <i />{live ? 'LIVE' : 'FIXTURE'}
      </span>
      {live && (
        <span className="mut">
          <span className="ink">{data.allowed_repos.join(', ')}</span>
          {' · write '}
          {data.live_writes
            ? <span className="ok" data-tip="승인하면 진짜 이슈가 만들어진다."
                data-tip-below="" data-tip-align="right" tabIndex={0}>on</span>
            : <span className="bad" data-tip="승인해도 이슈를 만들지 않는다."
                data-tip-below="" data-tip-align="right" tabIndex={0}>off</span>}
        </span>
      )}
      <span className="fnt">OPS_MODE</span>
    </span>
  );
}

function credShort(src?: 'api_key' | 'auth_token' | 'stored_login'): string {
  switch (src) {
    case 'api_key': return 'ANTHROPIC_API_KEY';
    case 'auth_token': return 'ANTHROPIC_AUTH_TOKEN';
    case 'stored_login': return '저장된 로그인(구독)';
    default: return '확인 중';
  }
}
