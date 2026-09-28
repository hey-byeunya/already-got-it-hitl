'use client';

/** 질문 게이트. 사람이 다 고른 뒤 한 번만 보낸다 - 부분 제출은 «안 고른 답» 을 남긴다. */
import { useState } from 'react';
import type { PendingQuestion } from '@/lib/types';

/**
 * 질문 글. **줄바꿈을 살린다.**
 *
 * 에이전트는 «질문 한 줄 + 빈 줄 + 번호 매긴 목록» 으로 적는다. 그런데 화면이
 * 그것을 한 덩어리로 그려 여백이 모두 뭉개졌다 — 굵은 글씨 열 줄이 통째로 이어져
 * 무엇을 묻는지조차 눈에 안 들어왔다.
 *
 * 첫 덩이(묻는 문장)만 굵게 두고, 나머지는 본문으로 내린다.
 *
 * **폭은 묶지 않는다.** 읽기 편한 줄 길이로 좁히면 한 항목이 여러 줄로 쪼개져,
 * 승인 여부를 가르는 조건이 줄바꿈 너머로 넘어간다 — 짧게 읽히는 대신
 * 뜻을 잘못 집을 여지가 생긴다. 이 글은 사람이 판단을 내리는 자리다.
 */
export function QuestionText({ text, multi }: { text: string; multi: boolean }) {
  const cut = text.indexOf('\n\n');
  const lead = (cut === -1 ? text : text.slice(0, cut)).trim();
  const body = cut === -1 ? '' : text.slice(cut + 2).trim();
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="prose"
        style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--ink)', wordBreak: 'keep-all' }}>
        {lead}
        {multi && <span className="note" style={{ fontWeight: 400 }}> · 여러 개 고를 수 있다</span>}
      </div>
      {/*
        줄마다 따로 그린다. 한 덩이에 text-indent 를 주면 첫 줄에만 걸려
        2번부터가 통째로 밀린다 (실제로 그렇게 만들어 보고 알았다).
        줄 단위로 주어야 「번호는 왼쪽, 넘어간 줄은 번호 오른쪽」이 된다.
      */}
      {body && (
        <div className="prose" style={{
          wordBreak: 'keep-all', fontSize: 13, lineHeight: 1.85,
          color: 'var(--prose)', marginTop: 8,
        }}>
          {body.split('\n').map((line, i) => {
            if (!line.trim()) return <div key={i} style={{ height: 9 }} />;
            // 매달린 들여쓰기는 «항목» 에만 준다. 그냥 문단에 주면 넘어간 줄이
            // 까닭 없이 밀려 들어가 목록처럼 읽힌다.
            const listy = /^\s*(\d+[.)]|[-*·])\s/.test(line);
            return (
              <div key={i}
                style={listy ? { paddingLeft: '1.7em', textIndent: '-1.7em' } : undefined}>
                {line}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 질문 게이트.
 *
 * **한 번에 다 고른 뒤 한 번만 보낸다.** 전에는 선택지 버튼이 저마다 바로 보냈다 -
 * 질문이 둘 이상인 묶음에서 하나를 누르면 그 자리에서 ask_user 가 닫혀,
 * 나머지 질문은 사람이 고르지도 않았는데 답 없이 넘어갔다 (실측: web-mtuqs7tv).
 * 고르는 동안에는 아무것도 보내지 않으므로 누른 것을 다시 바꿀 수 있다.
 *
 * 고른 값은 question_id+version 에 묶는다. 에이전트가 질문을 새로 내면 (버전이 오르면)
 * 앞서 고른 것은 버린다 - 다른 질문에 대한 답이 딸려 들어가면 안 된다.
 */
export function QuestionGate({ q, busy, onSubmit }: {
  q: PendingQuestion; busy: boolean; onSubmit: (answers: Record<string, string>) => void;
}) {
  const key = `${q.question_id} v${q.version}`;
  const [picked, setPicked] = useState<{ key: string; by: Record<string, string[]> }>(
    { key, by: {} },
  );
  const by = picked.key === key ? picked.by : {};
  const set = (question: string, label: string, multi: boolean) => {
    const cur = by[question] ?? [];
    const next = multi
      ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label])
      : (cur[0] === label ? [] : [label]);
    setPicked({ key, by: { ...by, [question]: next } });
  };
  const missing = q.questions.filter((x) => (by[x.question] ?? []).length === 0).length;

  return (
    <div className="strip warn">
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <div>
          <span className="wrn">?</span> <b>waiting for answer</b>{' '}
          <span className="mut">ask_user · {q.question_id} v{q.version}</span>
        </div>
        <span className="note">답하기 전에는 다음 단계로 넘어가지 않는다 - 정상 상태다</span>
      </div>
      {q.questions.map((x) => {
        const chosen = by[x.question] ?? [];
        return (
          <div key={x.question} style={{ marginTop: 12 }}>
            <QuestionText text={x.question} multi={Boolean(x.multiSelect)} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(228px,1fr))', gap: 9 }}>
              {x.options.map((o, i) => (
                <button className="opt" key={o.label} disabled={busy}
                  aria-pressed={chosen.includes(o.label)}
                  onClick={() => set(x.question, o.label, Boolean(x.multiSelect))}>
                  <span className="l">{i + 1} · {o.label}</span>
                  {o.description && <span className="d">{o.description}</span>}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
        <button className="go" disabled={busy || missing > 0}
          onClick={() => onSubmit(Object.fromEntries(
            q.questions.map((x) => [x.question, (by[x.question] ?? []).join(', ')]),
          ))}>
          answer ↵
        </button>
        <span className="note">
          {missing > 0
            ? <>아직 <span className="wrn">{missing}개</span> 남았다 - 모두 고르면 보낼 수 있다</>
            : '보내기 전까지는 다시 고를 수 있다'}
        </span>
      </div>
      <div className="note" style={{ marginTop: 10 }}>
        같은 question_id + version 은 한 번만 작업을 시작한다 - 두 번 눌러도 제작이 두 번 돌지 않는다
      </div>
    </div>
  );
}
