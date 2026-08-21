/**
 * Builds SUBMISSION.docx — the cover document a reviewer opens first.
 *
 * Deliberately short: 4 pages. It orients the reader, hands them the links,
 * and tells them how to evaluate the system in five minutes. The 26-page
 * technical design document is where the depth lives.
 *
 *   node tools/build-submission-docx.mjs
 */
import { writeFileSync } from 'node:fs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

const PAGE = { width: 12240, height: 15840 }; // US Letter, DXA
const MARGIN = 1080;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

const INK = '1A1A1A';
const MUTED = '5A6072';
const ACCENT = '0F766E';
const AMBER = 'B45309';
const RULE = 'D4D8E0';
const HEAD_BG = 'EFF2F6';
const BODY = 'Calibri';
const MONO = 'Consolas';

const REPO = 'https://github.com/Hari-R1506/distributed-job-scheduler';
const BLOB = `${REPO}/blob/main`;

// ── primitives ──────────────────────────────────────────────────────────────

const p = (text, o = {}) =>
  new Paragraph({
    spacing: { after: o.after ?? 140, line: 276 },
    alignment: o.align,
    children: [
      new TextRun({
        text,
        font: BODY,
        size: o.size ?? 21,
        color: o.color ?? INK,
        bold: o.bold,
        italics: o.italics,
      }),
    ],
  });

/** Paragraph from fragments: [text, {bold|code|italics|link}]. */
const rich = (parts, o = {}) =>
  new Paragraph({
    spacing: { after: o.after ?? 140, line: 276 },
    alignment: o.align,
    children: parts.map(([text, f = {}]) => {
      const run = new TextRun({
        text,
        font: f.code ? MONO : BODY,
        size: f.code ? 19 : (o.size ?? 21),
        color: f.link ? '1155CC' : (f.color ?? (f.code ? ACCENT : INK)),
        bold: f.bold,
        italics: f.italics,
        underline: f.link ? {} : undefined,
      });
      return f.link ? new ExternalHyperlink({ link: f.link, children: [run] }) : run;
    }),
  });

const h1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 340, after: 180 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 8 } },
    children: [new TextRun({ text, font: BODY, size: 30, bold: true, color: INK })],
  });

const h2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 120 },
    children: [new TextRun({ text, font: BODY, size: 23, bold: true, color: ACCENT })],
  });

const code = (lines) =>
  lines.map(
    (line, i) =>
      new Paragraph({
        spacing: { after: i === lines.length - 1 ? 160 : 0, line: 240 },
        indent: { left: 200 },
        shading: { type: ShadingType.CLEAR, fill: 'F5F7FA' },
        children: [new TextRun({ text: line || ' ', font: MONO, size: 18, color: '24292F' })],
      }),
  );

const quote = (text, color = ACCENT) =>
  new Paragraph({
    spacing: { before: 140, after: 200, line: 300 },
    indent: { left: 200 },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color, space: 14 } },
    children: [new TextRun({ text, font: BODY, size: 22, bold: true, color: INK })],
  });

const note = (text, label) =>
  new Paragraph({
    spacing: { before: 120, after: 180, line: 276 },
    indent: { left: 200 },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: AMBER, space: 12 } },
    children: [
      new TextRun({ text: `${label} — `, font: BODY, size: 20, bold: true, color: AMBER }),
      new TextRun({ text, font: BODY, size: 20, color: MUTED, italics: true }),
    ],
  });

const bullets = (items) =>
  items.map(
    (item) =>
      new Paragraph({
        numbering: { reference: 'b', level: 0 },
        spacing: { after: 90, line: 276 },
        children:
          typeof item === 'string'
            ? [new TextRun({ text: item, font: BODY, size: 21, color: INK })]
            : item.map(([t, f = {}]) =>
                new TextRun({
                  text: t,
                  font: f.code ? MONO : BODY,
                  size: f.code ? 19 : 21,
                  color: f.color ?? (f.code ? ACCENT : INK),
                  bold: f.bold,
                  italics: f.italics,
                }),
              ),
      }),
  );

/**
 * Cells split on '|' alternate body/mono. A cell may instead be
 * { text, link } to render as a hyperlink.
 */
function table(headers, rows, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const cols = weights.map((w) => Math.round((w / total) * CONTENT_WIDTH));
  cols[cols.length - 1] = CONTENT_WIDTH - cols.slice(0, -1).reduce((a, b) => a + b, 0);

  const mk = (value, i, header) => {
    let children;
    if (value && typeof value === 'object' && value.link) {
      children = [
        new ExternalHyperlink({
          link: value.link,
          children: [
            new TextRun({
              text: value.text,
              font: BODY,
              size: 19,
              color: '1155CC',
              underline: {},
            }),
          ],
        }),
      ];
    } else {
      children = String(value)
        .split('|')
        .map((seg, k) =>
          new TextRun({
            text: seg,
            font: k % 2 === 1 ? MONO : BODY,
            size: k % 2 === 1 ? 17 : 19,
            bold: header,
            color: header ? INK : k % 2 === 1 ? ACCENT : INK,
          }),
        );
    }
    return new TableCell({
      width: { size: cols[i], type: WidthType.DXA },
      margins: { top: 70, bottom: 70, left: 110, right: 110 },
      shading: header ? { type: ShadingType.CLEAR, fill: HEAD_BG } : undefined,
      children: [new Paragraph({ spacing: { after: 0, line: 250 }, children })],
    });
  };

  return new Table({
    columnWidths: cols,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
    rows: [
      ...(headers
        ? [new TableRow({ tableHeader: true, children: headers.map((h, i) => mk(h, i, true)) })]
        : []),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => mk(c, i, false)) })),
    ],
  });
}

const spacer = (after = 200) => new Paragraph({ spacing: { after }, children: [] });

// ── document ────────────────────────────────────────────────────────────────

const children = [];

// Title block
children.push(spacer(900));
children.push(
  new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: 'Distributed Job Scheduler', font: BODY, size: 48, bold: true, color: INK }),
    ],
  }),
);
children.push(
  new Paragraph({
    spacing: { after: 260 },
    children: [
      new TextRun({ text: 'Technical Assignment Submission', font: BODY, size: 26, color: ACCENT }),
    ],
  }),
);
children.push(
  new Paragraph({
    spacing: { after: 300 },
    border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 12 } },
    children: [],
  }),
);

children.push(
  table(
    null,
    [
      ['Candidate', 'Hari R'],
      ['Submitted to', 'Codity.AI'],
      ['Date', new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })],
      ['Repository', { text: REPO, link: REPO }],
      ['Stack', 'TypeScript · NestJS · PostgreSQL 16 · React · Docker'],
    ],
    [1, 3.4],
  ),
);

children.push(spacer(340));

// ── What was built ──
children.push(h1('What was built'));
children.push(
  p(
    'A distributed job scheduling platform in which multiple worker processes claim from the same queues concurrently and never execute the same job twice — and in which any worker can be terminated at any moment without losing work or requiring human intervention.',
  ),
);
children.push(
  p(
    'Seven containers start with a single command: PostgreSQL, a REST API, a leader-elected scheduler, three independent workers, and a React dashboard.',
  ),
);
children.push(p('The governing design decision, from which every reliability property follows:'));
children.push(
  quote(
    'The database is the queue. Workers hold short transactions to claim work, and hold no transaction while doing work.',
  ),
);

children.push(new Paragraph({ children: [new PageBreak()] }));

// ── Deliverables ──
children.push(h1('Deliverables'));
children.push(
  table(
    ['#', 'Required', 'Where'],
    [
      ['1', 'Source code and setup instructions', { text: 'repository · README.md · docs/SETUP.md', link: `${BLOB}/docs/SETUP.md` }],
      ['2', 'Architecture diagram', { text: 'docs/ARCHITECTURE.md — 6 diagrams', link: `${BLOB}/docs/ARCHITECTURE.md` }],
      ['3', 'ER diagram', { text: 'docs/DATABASE.md — 16 tables', link: `${BLOB}/docs/DATABASE.md` }],
      ['4', 'API documentation', { text: 'docs/API.md · Swagger at /docs · openapi.json', link: `${BLOB}/docs/API.md` }],
      ['5', 'Design decisions', { text: 'docs/DESIGN-DECISIONS.md — 12 trade-offs', link: `${BLOB}/docs/DESIGN-DECISIONS.md` }],
      ['6', 'Automated tests', { text: 'tests/ — unit · integration · concurrency', link: `${REPO}/tree/main/tests` }],
    ],
    [0.3, 2, 3.4],
  ),
);
children.push(spacer(180));
children.push(
  rich([
    ['Consolidated technical design document (Word, 26 pages): ', {}],
    ['docs/Distributed-Job-Scheduler-Technical-Design.docx', { link: `${BLOB}/docs/Distributed-Job-Scheduler-Technical-Design.docx` }],
  ]),
);
children.push(
  rich([
    ['Measured evidence for every claim in this document: ', {}],
    ['docs/VERIFICATION.md', { link: `${BLOB}/docs/VERIFICATION.md` }],
  ]),
);

// ── Evaluating ──
children.push(h1('Evaluating it in five minutes'));
children.push(
  ...code([
    'git clone https://github.com/Hari-R1506/distributed-job-scheduler.git',
    'cd distributed-job-scheduler',
    'cp .env.example .env',
    'npm install && npm run db:generate',
    'docker compose up -d --build',
  ]),
);
children.push(
  rich([
    ['Register an account at ', {}],
    ['http://localhost:5173', { code: true }],
    [', then run ', {}],
    ['npm run seed', { code: true }],
    ['.', {}],
  ]),
);

children.push(h2('The demonstration'));
children.push(p('Open the Workers page, then:'));
children.push(...code(['docker kill djs-worker-2']));
children.push(
  p(
    'SIGKILL — instant termination, no drain, no lease release. Equivalent to a server losing power mid-job.',
  ),
);
children.push(
  ...bullets([
    [['At roughly 30 seconds', { bold: true }], [' the scheduler marks the worker DEAD after six missed heartbeats.', {}]],
    [['At roughly 60 seconds', { bold: true }], [' the reaper finds its expired leases, closes those attempts as ABANDONED, and requeues the jobs.', {}]],
    [['Immediately after', { bold: true }], [' the surviving workers claim and complete them.', {}]],
  ]),
);
children.push(
  rich([
    ['Nothing is lost, and nobody intervenes. ', { bold: true }],
    ['Contrast with docker stop, which sends SIGTERM: the worker drains its in-flight jobs and exits cleanly in about three seconds, with no job retried.', {}],
  ]),
);

children.push(new Paragraph({ children: [new PageBreak()] }));

// ── Engineering ──
children.push(h1('Where the engineering is'));
children.push(
  p(
    'The rubric weights architecture, database and backend at 60 of 100 marks. Effort was allocated accordingly.',
  ),
);

children.push(h2('Atomic claiming'));
children.push(
  rich([
    ['FOR UPDATE SKIP LOCKED', { code: true }],
    [' inside a ', {}],
    ['per-queue advisory lock', { bold: true }],
    ['. The lock is not decorative: SKIP LOCKED alone cannot enforce a per-queue concurrency limit, because that limit is a constraint over an ', {}],
    ['aggregate', { italics: true }],
    [', and aggregates are not lockable. Two workers reading the same MVCC snapshot both see zero running and both claim full capacity. The lock is held for 1–3 ms — the duration of the claim decision, never of execution.', {}],
  ]),
);
children.push(
  p(
    'READ COMMITTED is used deliberately: the locking is explicit, so the database need not infer conflicts, and SERIALIZABLE’s serialisation failures are avoided entirely.',
  ),
);

children.push(h2('The database'));
children.push(
  rich([['16 tables · 36 foreign keys · 14 CHECK constraints · 8 partial indexes.', { bold: true }]]),
);
children.push(p('Two decisions carry the design:'));
children.push(
  ...bullets([
    [
      ['jobs holds the unit of work; job_executions holds one row per attempt.', { bold: true }],
      [' Attempts fail; jobs die. That split is what makes retry history, per-attempt timings and per-attempt errors queryable rather than squashed into an unindexable blob.', {}],
    ],
    [
      ['The claim index is partial, and its column order is the ORDER BY.', { bold: true }],
      [' Measured at 50,000 rows: an Index Scan with no Sort node, 12 buffer hits, 0.098 ms. Claim cost depends on queue depth, not table size.', {}],
    ],
  ]),
);
children.push(
  p(
    'Cascade rules are chosen per relationship — 21 CASCADE for ownership chains, 13 SET NULL for attribution, and one deliberate RESTRICT so that deleting a retry policy a queue depends on fails loudly rather than silently.',
  ),
);
children.push(
  note(
    'There are deliberately no counter columns on queues. Incrementing one on every completion would take a row lock on a single row per queue, making that row the serialisation point for the entire queue — a global mutex by accident.',
    'Design',
  ),
);

children.push(h2('Reliability'));
children.push(
  p(
    'Renewable leases, heartbeats, and a reaper. Attempts are counted at claim, not at completion — otherwise a job that crashes its worker is reclaimed forever, a poison pill that kills the fleet one process at a time.',
  ),
);
children.push(
  rich([
    ['Graceful shutdown ', {}],
    ['keeps heartbeating while draining', { bold: true }],
    ['. Stop, and the reaper reclaims your in-flight jobs while you are still running them — causing the duplicate execution the design exists to prevent, on every deploy.', {}],
  ]),
);
children.push(
  p(
    'Cron materialisation is guarded twice: an optimistic CAS on the cursor, and a unique index on (scheduled_job_id, scheduled_for). Belt and braces is right there and nowhere else — a nightly billing job firing twice is silent and unrecoverable.',
  ),
);

children.push(new Paragraph({ children: [new PageBreak()] }));

// ── Verification ──
children.push(h1('Verification'));
children.push(p('Claims in the documentation are measured, not asserted.'));
children.push(
  table(
    ['Check', 'Result'],
    [
      ['Backend and frontend type checking', '0 errors'],
      ['Unit tests', '85 / 85 passing'],
      ['Migrations against PostgreSQL 16', 'Applied clean on the first attempt'],
      ['Claim query plan', 'Index Scan, no Sort node, 0.098 ms over 50,000 rows'],
      ['Exactly-once claiming', '20 concurrent claimers, 500 jobs → 500 claims, 0 duplicates'],
      ['Per-queue concurrency', 'Never exceeded — and demonstrably saturated'],
      ['Cron under two schedulers', 'Exactly one job materialised'],
      ['Containerised SIGTERM drain', 'All in-flight jobs COMPLETED, exit 0 in 3.5 s'],
      ['Containerised SIGKILL recovery', 'All jobs recovered by surviving workers'],
    ],
    [2, 3],
  ),
);
children.push(spacer(160));
children.push(
  note(
    'Testcontainers is used rather than a mock, deliberately: an in-memory database cannot exhibit SKIP LOCKED semantics, row locks or MVCC snapshots — so a mocked concurrency test proves nothing about the property it claims to verify.',
    'On testing',
  ),
);

// ── Scope ──
children.push(h1('Scope decisions'));
children.push(
  rich([
    ['Built from the bonus list — ', {}],
    ['distributed locking', { bold: true }],
    [' (leader election, which the scheduler requires anyway) and ', {}],
    ['event-driven execution', { bold: true }],
    [' (LISTEN/NOTIFY, with polling underneath as the correctness guarantee).', {}],
  ]),
);
children.push(
  rich([
    ['Deliberately not built — ', {}],
    ['queue sharding, workflow DAGs, and multi-region.', { bold: true }],
    [' Each is documented with what it would take and why it did not earn its place. A half-working DAG engine reads worse than none.', {}],
  ]),
);
children.push(
  quote(
    'Exactly-once execution is impossible when side effects are external to the database. The system guarantees at-least-once and pushes idempotency to the boundary. Claiming exactly-once would be false.',
    AMBER,
  ),
);
children.push(
  p(
    'A worker cannot atomically "send the email" and "record that it sent the email" — those are two systems with no shared transaction. Handlers therefore receive a stable execution token to deduplicate with, and the built-in HTTP handler forwards it downstream as an Idempotency-Key header.',
  ),
);

// ── Repository ──
children.push(h1('Repository'));
children.push(rich([[REPO, { link: REPO, bold: true }]], { after: 180 }));
children.push(
  ...code([
    'packages/core     pure domain logic — no I/O, imported by every service',
    'packages/db       Prisma schema, migrations, and the hot-path SQL',
    'apps/api          NestJS REST API — 56 operations',
    'apps/worker       claim loop, executor pool, heartbeat, handler registry',
    'apps/scheduler    promotion, cron, reaper, metrics rollup, leader election',
    'apps/web          React dashboard, served by nginx',
    'tests/            unit · integration · concurrency',
  ]),
);
children.push(
  rich([
    ['packages/db/sql/claim-jobs.sql', { code: true }],
    [' is the most important file in the project.', {}],
  ]),
);

children.push(spacer(300));
children.push(
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 260 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 12 } },
    children: [
      new TextRun({ text: 'Thank you for reviewing.', font: BODY, size: 19, italics: true, color: MUTED }),
    ],
  }),
);

const doc = new Document({
  creator: 'Hari R',
  title: 'Distributed Job Scheduler — Submission',
  description: 'Codity.AI technical assignment submission',
  styles: { default: { document: { run: { font: BODY, size: 21, color: INK } } } },
  numbering: {
    config: [
      {
        reference: 'b',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 420, hanging: 220 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: { size: PAGE, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } },
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'Hari R  ·  Distributed Job Scheduler  ·  ', font: BODY, size: 16, color: MUTED }),
                new TextRun({ children: [PageNumber.CURRENT], font: BODY, size: 16, color: MUTED }),
              ],
            }),
          ],
        }),
      },
      children,
    },
  ],
});

const out = 'SUBMISSION.docx';
const buf = await Packer.toBuffer(doc);
writeFileSync(out, buf);
console.log(`wrote ${out} (${(buf.length / 1024).toFixed(0)} KB)`);
