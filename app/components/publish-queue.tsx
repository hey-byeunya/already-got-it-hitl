'use client';

/** 발행 대기 — 홈의 링크와 /publish 목록이 같은 데이터를 본다 (GET /api/publish). */
import { useEffect, useState } from 'react';
import Link from 'next/link';

export type QueueRow = {
  run_id: string;
  status: 'pending_review' | 'retrying' | 'approved' | 'rejected' | 'sending' | 'published' | 'send_failed';
  route: 'review' | 'auto';
  waiting_question: boolean;
  rules: string[];
  period: { since: string; until: string } | null;
  created_at: string; updated_at: string;
};
export type Queue = { rows: QueueRow[]; waiting: number; dry_run: boolean };

export function useQueue(): Queue | null {
  const [q, setQ] = useState<Queue | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await fetch('/api/publish', { cache: 'no-store' }).catch(() => null);
      if (alive && res?.ok) setQ(await res.json() as Queue);
    };
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return q;
}

/** 홈 머리의 한 줄. 사람이 답할 건이 있으면 호박색으로 먼저 보인다. */
export function PublishQueueLink() {
  const q = useQueue();
  if (!q) return null;
  return (
    <Link href="/publish" className={q.waiting ? 'wrn' : 'mut'} style={{ fontSize: 11, letterSpacing: '.08em' }}>
      [ PUBLISH ] waiting {q.waiting}{q.dry_run ? ' · DRY_RUN' : ''} →
    </Link>
  );
}
