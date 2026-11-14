// Compare Bonsai 4B/9B pooled embeddings on the same small paraphrase probe.
// Requires BONSAI_DEMO_DIR pointing to a local PrismML bonsai-demo checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cosineVector } from '../src/embeddings.mjs';

const docs = [
  "Maya · health: Knee surgery at Mercy Hospital this Friday",
  "Me · promise: Water Maya's tomato plants every evening; spare key under the blue pot",
  "Priya · family: Maya's daughter driving down from Boston to stay with her",
  'Me · medication: Lisinopril raised from 5 mg to 10 mg, once every morning',
  'Me · health: Avoid potassium supplements and grapefruit juice',
  'Dr. Patel · plan: Follow-up appointment December 3, bring blood pressure log',
  'Sam · plan: Coming for lunch Sunday around noon with Lily',
  'Lily · health: Allergic to peanuts, no peanut cookies',
];
const decoys = Number(process.argv.find((a) => a.startsWith('--decoys='))?.split('=')[1] ?? 0);
if (!Number.isInteger(decoys) || decoys < 0 || decoys > 500) throw new Error('decoys must be 0–500');
const topics = [
  'collected a library book about astronomy', 'repaired a bicycle tire', 'paid a utility bill',
  'reserved a table at a cafe', 'bought a train ticket', 'mailed a parcel at the post office',
  'watched a football match', 'returned a sweater to the store', 'picked up a new phone charger',
  'signed a lease for a storage unit',
];
for (let i = 0; i < decoys; i++)
  docs.push(`Contact ${i} · personal: ${topics[i % topics.length]} on day ${i % 28 + 1}, reference ${i}`);
const cases = [
  ['Who is having an operation soon?', 0],
  ['Did anyone need help with their garden?', 1],
  ['Is someone visiting my neighbour from out of town?', 2],
  ['What did the doctor change about my pills?', 3],
  ['Which foods or drinks should I stay away from?', 4],
  ['When do I go back to the clinic?', 5],
  ['Who is coming over this weekend?', 6],
  ["What can't the kids eat?", 7],
  ['How much of my heart medicine do I take now?', 3],
  ['Where did Maya hide her house key?', 1],
];
const root = process.env.BONSAI_DEMO_DIR;
if (!root) throw new Error('Set BONSAI_DEMO_DIR to the local bonsai-demo checkout');
const modelSize = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] ?? '4B';
if (!['4B', '9B'].includes(modelSize)) throw new Error('model must be 4B or 9B');
const input = path.join(os.tmpdir(), `kindred-embedding-compare-${process.pid}.txt`);
fs.writeFileSync(input, [...docs, ...cases.map((c) => c[0])].join('\n') + '\n');
try {
  for (const size of [modelSize]) {
    const model = path.join(root, `models/bonsai2-gguf/${size}/Ternary-Bonsai-2-${size}-PQ2_0.gguf`);
    const t0 = Date.now();
    const result = spawnSync(path.join(root, 'bin/mac/llama-embedding'), [
      '-m', model, '-dev', 'none', '-ngl', '0', '--no-op-offload', '-fit', 'off',
      '-c', '8192', '--pooling', 'mean', '--embd-output-format', 'json', '-f', input,
    ], { encoding: 'utf8', maxBuffer: 20_000_000 });
    if (result.status !== 0) throw new Error(`${size} embedding failed: ${result.stderr.slice(-700)}`);
    const vectors = JSON.parse(result.stdout).data.map((r) => r.embedding);
    if (vectors.length !== docs.length + cases.length) throw new Error(`${size}: incomplete vector output`);
    let top1 = 0, mrr = 0;
    const misses = [];
    for (let i = 0; i < cases.length; i++) {
      const order = docs.map((_, j) => [j, cosineVector(vectors[docs.length + i], vectors[j])])
        .sort((a, b) => b[1] - a[1]).map((x) => x[0]);
      const rank = order.indexOf(cases[i][1]) + 1;
      top1 += Number(rank === 1);
      mrr += 1 / rank;
      if (rank !== 1) misses.push({ question: cases[i][0], expected: cases[i][1], rank, top: order[0] });
    }
    console.log(JSON.stringify({ model: size, memories: docs.length, dim: vectors[0].length, top1: `${top1}/${cases.length}`,
      mrr: Number((mrr / cases.length).toFixed(3)), totalMs: Date.now() - t0, misses }, null, 2));
  }
} finally { fs.rmSync(input, { force: true }); }
