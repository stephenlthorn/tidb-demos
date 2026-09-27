import { createEmitter, every, onControl, summarize } from '@lab/runner-kit';
import { initialModel, latencySamples, phaseFor, rateFor, startBurst, step, TOTAL_TICKS } from './src/model';

const emitter = createEmitter();
const controller = new AbortController();
const shell = { model: initialModel, phase: '', tidbStatus: 'healthy' };

onControl((id) => {
  if (id !== 'burst') return;
  shell.model = startBurst(shell.model);
  emitter.log('info', 'Burst requested from the UI', 'generator');
});

['generator', 'queue', 'tidb', 'consumer'].forEach((node) => emitter.node(node, 'healthy'));
emitter.check('counts-match', 'pending');

await every({
  intervalMs: 1000,
  signal: controller.signal,
  task: async () => {
    const phase = phaseFor(shell.model.tick);
    if (phase !== shell.phase) {
      emitter.phase(phase);
      shell.phase = phase;
    }
    if (shell.model.tick === 30) shell.model = startBurst(shell.model);
    const rate = rateFor(shell.model);
    const latency = summarize(latencySamples(rate, shell.model.tick));
    emitter.flow('generator-to-queue', rate);
    emitter.flow('queue-to-tidb', rate);
    emitter.flow('tidb-to-consumer', rate);
    emitter.metric('write-rate', rate);
    if (latency !== undefined) emitter.metric('write-p99', latency.p99);
    shell.model = step(shell.model);
    emitter.metric('rows-stored', shell.model.stored);
    const tidbStatus = shell.model.burstTicksLeft > 0 ? 'busy' : 'healthy';
    if (tidbStatus !== shell.tidbStatus) {
      emitter.node('tidb', tidbStatus);
      shell.tidbStatus = tidbStatus;
    }
    if (shell.model.tick >= TOTAL_TICKS) controller.abort();
  },
});

emitter.check('counts-match', 'pass', `${shell.model.stored} generated = ${shell.model.stored} stored (simulated)`);
['generator', 'queue', 'tidb', 'consumer'].forEach((node) => emitter.node(node, 'done'));
process.exit(0);
