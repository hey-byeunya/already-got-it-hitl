/** 화면과 서버가 주고받는 실행 상태. API_SPEC.md 의 상태값을 그대로 쓴다. */
export type RunStatus =
  | 'planning' | 'running' | 'waiting_for_user'
  | 'failed' | 'stopped' | 'done'
  /** 서버가 재시작돼 메모리에서 기다리던 콜백이 사라진 상태. */
  | 'interrupted';

export type TraceEvent = {
  seq: number;
  at: string;
  kind: string;
  /** 사람이 읽을 한 줄. */
  label: string;
  /** 펼쳐 볼 상세 (도구 입력·출력 전문 등). */
  detail?: string;
  isError?: boolean;
};

export type PendingQuestion = {
  question_id: string;
  version: number;
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiSelect?: boolean;
  }[];
};

export type PendingApproval = {
  approval_id: string;
  version: number;
  tool: string;
  /** 사람이 승인 전에 봐야 하는 내용. */
  summary: Record<string, unknown>;
};

export type UsageView = {
  usage_known: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  cost_is_estimate: true;
  unknown_reason?: string;
};

export type RunState = {
  run_id: string;
  fixture_id: string | null;
  /** 어느 엔진으로 도는가. 지금은 Claude Agent SDK 하나다. */
  engine: 'claude';
  status: RunStatus;
  created_at: string;
  updated_at: string;
  session_id?: string;
  goal: string;
  trace: TraceEvent[];
  pending_question: PendingQuestion | null;
  pending_approval: PendingApproval | null;
  /** 답한 질문. 같은 질문을 다시 묻지 않기 위해 남긴다. */
  answered: { question_id: string; version: number; answers: Record<string, string>; headers?: string[] }[];
  /** 승인·거절 이력. */
  decisions: { approval_id: string; tool: string; approved: boolean; reason?: string; at: string; title?: string; target?: string }[];
  usage: UsageView | null;
  stop_reason?: { limit: string; message: string; observed: number; allowed: number };
  final_text?: string;
  charts: { card_no: number; svg_path: string }[];
  /** 이 실행을 이 서버 프로세스가 돌리고 있는가. 재시작 감지에 쓴다. */
  live: boolean;
  /**
   * 어느 자격증명으로 돌았는가. 비용이 어느 지갑에서 빠지는지가 달라진다.
   *
   */
  credential_source?: 'api_key' | 'auth_token' | 'stored_login';
  /**
   * 이 실행에 걸린 상한. 화면의 예산 게이지가 쓰는 **분모**다.
   * 전에는 '실행 시작' 트레이스의 문자열 안에만 있어서 값으로 꺼낼 수 없었다.
   */
  limits?: RunLimits;
  /** 깊게 볼 축. 비우면 에이전트가 판단한다. */
  focus?: string;
  /** 브리핑 기간. 프롬프트 줄에 --since/--until 로 보인다. */
  period?: { since: string; until: string };
  /** 지금 카드뉴스를 굽고 있는가. 두 번 눌러 두 번 굽지 않게 한다. */
  cards_exporting?: boolean;
  /**
   * 엔진이 잰 실행 시간(초). 대기 시간은 빠져 있다.
   *
   * created_at → updated_at 으로 계산하면 안 된다 — updated_at 은 실행이 끝난 뒤에도
   * 카드 내보내기 같은 작업으로 갱신돼, 600초에 끝난 실행이 «4,970s / 600s 상한» 으로 보인다.
   */
  elapsed_seconds?: number;
};

export type RunLimits = {
  maxTurns: number;
  maxToolCalls: number;
  maxBudgetUsd: number;
  maxElapsedSeconds: number;
  maxInputTokens: number;
  maxSameToolStreak: number;
};

/** 네 축 요약. toolcalls.jsonl 에서 유도한다 — 새로 조회하지 않는다. */
export type AxisTile = {
  key: 'system' | 'users' | 'dev' | 'trend';
  /** 큰 숫자. 조회하지 못했으면 null 이다 — 0 이 아니다. */
  value: number | null;
  /** 숫자 옆에 붙는 짧은 설명. */
  note: string;
  /** note 뒤에 `· xxx` 로 붙는 에러 구간. 0 초과면 bad, 0이면 흐리게 그린다. 없으면 붙이지 않는다. */
  alert?: { text: string; tone: 'bad' | 'mut' };
  tone: 'ok' | 'warn' | 'bad' | 'mut';
};

export type AxesView = {
  tiles: AxisTile[];
  /** 도구들이 알린 결측 필드의 합집합. */
  unavailable_fields: string[];
  /** 도구를 하나도 안 불렀으면 false — 화면이 «아직 없다»로 그린다. */
  collected: boolean;
};

/** compose_card 가 남긴 카드. runs/{id}/cards/NN.json 을 그대로 읽는다. */
export type CardView = {
  card_no: number;
  kind: 'cover' | 'metric' | 'text';
  title: string;
  body: string[];
  sources: string[];
  chart_path?: string;
  /** 심각도 딱지. category(D40) 가 정본이고, 없는 옛 카드는 accent·chart_path 로 정한다. */
  severity: 'FIX_NOW' | 'WATCH' | 'METRICS' | 'FYI' | 'COVER';
};

/**
 * 이 실행이 언급하는 바깥 것들의 주소.
 *
 * 픽스처 모드에서는 이 참조가 **스냅샷 안의 것**이다 — 실제 저장소에는 없을 수 있다.
 * 그래서 `snapshot` 을 함께 내려보내 화면이 그 사실을 밝히게 한다.
 */
export type RunLinks = {
  repo: string | null;
  issues: { number: number; title: string; url: string }[];
  pulls: { number: number; url: string }[];
  /** web_search 가 돌려준 출처. url 중복은 접는다. */
  web: { title: string; url: string; published_at: string | null }[];
  /** 승인을 받아 만든 이슈. fixture 모드면 simulated 다 — 실제로는 만들어지지 않았다. */
  created: { number: number; repo: string; url: string | null; simulated: boolean }[];
  /** 픽스처 실행인가. true 면 위 참조는 스냅샷 안의 것이다. */
  snapshot: boolean;
};

/**
 * 내보낸 결과물. 디스크에 실제로 있는 것만 담는다 —
 * 화면이 «내려받기» 를 보여 놓고 404 를 주면 안 된다.
 */
export type ExportView = {
  zip: { name: string; bytes: number } | null;
  sources: boolean;
  png: { card_no: number; bytes: number }[];
};

/** [ PROGRESS ] 6단계. 트레이스에서 유도한다. */
export type Step = {
  label: string;
  state: 'done' | 'current' | 'pending';
};

/** 화면이 받는 실행 상세 — 저장된 상태 + 디스크에서 유도한 값. */
export type RunDetail = RunState & {
  axes: AxesView;
  cards: CardView[];
  steps: Step[];
  links: RunLinks;
  exports: ExportView;
};

/** 홈 목록의 한 줄. */
export type RunRow = {
  run_id: string;
  status: RunStatus;
  created_at: string;
  fixture_id: string | null;
  engine: 'claude';
  /** 모르면 null 이다. 0 으로 적으면 «비용이 안 들었다»는 거짓 보고가 된다. */
  cost: number | null;
  /** 한 줄 결과 요약. */
  result: string;
  /** 깊게 볼 축 (--axis 입력값). 옛 실행에는 없다. */
  focus?: string;
  /** 브리핑이 다룬 기간. 옛 실행에는 없다. */
  period?: { since: string; until: string };
};
