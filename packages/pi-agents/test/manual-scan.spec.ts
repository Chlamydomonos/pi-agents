import { describe, it } from 'vitest';
import { loadAll, defaultRoots } from '../src/extension/loader/load.js';

describe('manual scan', () => {
    it('scans workspace flows', async () => {
        const cwd = '/root/ai/chlamydomonos-harness/workspaces/pi-agents-live';
        const result = await loadAll(defaultRoots(cwd), (m) => console.warn('[warn]', m));
        console.log(
            'flows:',
            result.flows.map((f) => f.def.name),
        );
        console.log(
            'agents:',
            result.agents.map((a) => a.def.name),
        );
        console.log(
            'invalid:',
            result.invalid.map((i) => i.file + ' :: ' + (i.reasons[0] ?? '')),
        );
    });
});
