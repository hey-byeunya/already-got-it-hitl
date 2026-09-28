/** 바깥 참조를 화면에 붙이는 것들. 픽스처 참조는 실제라고 말하지 않는다 (D26). */
import type { RunLinks } from '@/lib/types';

/** 바깥으로 나가는 링크. 새 탭으로 열고 referrer 를 보내지 않는다. */
export function Out({ href, children, title }: {
  href: string; children: React.ReactNode; title?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener"
      {...(title ? { title } : {})}>{children}</a>
  );
}

/**
 * 글 안의 `#12` 를 이슈·PR 링크로 바꾼다.
 *
 * **이 실행이 실제로 조회한 번호만** 링크한다. 아무 숫자나 링크하면
 * 없는 이슈를 가리키게 되고, 카드에 적힌 «47건» 같은 수치까지 링크가 된다.
 */
export function linkRefs(text: string, links: RunLinks): React.ReactNode {
  if (!links.repo) return text;
  const known = new Map<number, { url: string; kind: string }>();
  for (const i of links.issues) known.set(i.number, { url: i.url, kind: 'issue' });
  for (const p of links.pulls) known.set(p.number, { url: p.url, kind: 'PR' });
  if (known.size === 0) return text;

  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/#(\d+)/g)) {
    const hit = known.get(Number(m[1]));
    if (!hit) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <Out key={`${m.index}-${m[1]}`} href={hit.url}
        title={links.snapshot
          ? `픽스처 스냅샷의 ${hit.kind} 참조 - 실제 저장소에 없을 수 있다`
          : `${links.repo} ${hit.kind} #${m[1]}`}>
        {m[0]}
      </Out>,
    );
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
