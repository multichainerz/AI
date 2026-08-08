// Asserts the deployment ceilings and exposure of compose.yaml.
//
// Lived in .github/workflows/verify.yml as an inline script, where the only way
// to run it was to open a pull request -- so the rule it enforced could not be
// tested itself, and it went green on a rule that broke every small host. Here
// it runs locally, and a change to the rule can be proven before it merges.
//
// Read through `docker compose config`, not grepped out of the YAML: a value
// that looks right in source but does not survive interpolation or the merge
// keys still fails here.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The subject is what the repository declares, so the interpolation is starved
// of everything the caller could feed it.
//
// compose.yaml deliberately invites operators to tune each of these variables
// for their host, and `config` resolves them from the ambient environment. That
// made a developer who had exported ORCASYNAPSE_WORKER_CPU_SHARES for a local
// experiment fail this guard with a complaint about a compose.yaml that is
// entirely correct -- and no CI runner could ever reproduce it, because no CI
// runner has that variable set. An operator's own tuning is their host's
// business; the shipped defaults are this file's.
//
// An empty --env-file rather than none: with no --env-file, compose reads a
// developer's .env from the project directory, which is the same leak by a
// second route. COMPOSE_FILE is dropped with the rest because it would redirect
// `config` at some other file entirely, leaving this guard green while saying
// nothing at all about compose.yaml.
const scratchDirectory = mkdtempSync(join(tmpdir(), 'orcasynapse-limits-'));
const declaredDefaultsOnly = join(scratchDirectory, 'defaults.env');
writeFileSync(declaredDefaultsOnly, '');
// Matched case-insensitively because Windows environment names are: a developer
// who set orcasynapse_worker_cpu_shares in PowerShell would still have it
// resolved by name, and a filter that only knew the uppercase spelling would
// hand it straight back through.
const environmentWithoutOverrides = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => {
    const normalized = name.toUpperCase();
    return !normalized.startsWith('ORCASYNAPSE_') && normalized !== 'COMPOSE_FILE';
  }),
);

let resolvedConfiguration;
try {
  resolvedConfiguration = execFileSync(
    'docker',
    [
      'compose',
      '--file',
      'compose.yaml',
      '--env-file',
      declaredDefaultsOnly,
      'config',
      '--format',
      'json',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environmentWithoutOverrides,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
} catch (error) {
  // Docker is the interpreter here, not a convenience, so there is no degraded
  // mode to fall back to -- reading the YAML directly is exactly the thing this
  // file exists to avoid. Say which of the two it is instead of re-throwing a
  // spawn object: a developer on Windows without Docker Desktop was otherwise
  // shown a Node internals dump and no indication that CI would be fine.
  if (error.code === 'ENOENT') {
    console.error(
      'docker is not on PATH, so the resolved compose configuration cannot be read. This check reads `docker compose config` on purpose -- a value that looks right in the YAML but does not survive interpolation still has to fail here. Run it where Docker is available (CI, or WSL on a Windows workstation).',
    );
    process.exit(1);
  }
  throw error;
} finally {
  rmSync(scratchDirectory, { recursive: true, force: true });
}
const { services } = JSON.parse(resolvedConfiguration);

const problems = [];
for (const [name, service] of Object.entries(services).sort()) {
  // mem_limit is the ceiling that matters: unbounded, the worker's ~2 GB of
  // BGE-M3 weights hand the kernel OOM killer a choice and it picks PostgreSQL
  // by RSS. pids_limit bounds a fork storm the same way.
  for (const field of ['mem_limit', 'pids_limit', 'cpu_shares']) {
    if (!service[field]) problems.push(`${name}: no ${field}`);
  }
  // `cpus` is a cap rather than a weight, and every value of it is rejected.
  //
  // Compose maps it to NanoCPUs, and the daemon's range check is exactly
  // NanoCPUs > NCPU * 1e9. Above that line it refuses to create the container
  // at all -- "range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs
  // available" -- so a number that suits the documented 8 vCPU VM1 is not a
  // slower install on a 2 vCPU host, it is no install. Below that line nothing
  // refuses, which is why rejecting the rest is a policy call and not a range
  // rule: a sub-core cap creates fine on every host and then throttles the
  // large VM1 the host floor asks operators to buy, holding embedding down
  // while cores sit idle. cpu_shares carries the intent that actually mattered
  // -- who yields under contention -- and can be neither out of range nor a
  // throttle at any host size.
  if (service.cpus) {
    problems.push(
      `${name}: cpus ${service.cpus} caps CPU instead of weighting it. The daemon refuses creation only when NanoCPUs exceeds the host CPU count (NanoCPUs > NCPU * 1e9), so a value like this one is a host-size assumption above that line and a permanent throttle below it. Use cpu_shares.`,
    );
  }
  if (!(service.cap_drop ?? []).includes('ALL')) problems.push(`${name}: does not cap_drop ALL`);
  if (!(service.security_opt ?? []).some((option) => option.startsWith('no-new-privileges:true'))) {
    problems.push(`${name}: no security_opt no-new-privileges:true`);
  }
  // A published port with no bind address takes Docker's NAT path, which is
  // evaluated before ufw's INPUT chain, so a host firewall rule on it silently
  // does nothing.
  for (const port of service.ports ?? []) {
    if (!port.host_ip) problems.push(`${name}: port ${port.published} published with no bind address`);
  }
}

// The point of the weights, not just their presence: under contention the
// worker's embedding burst must yield to the database everything else waits on.
if (services.worker?.cpu_shares > services.postgres?.cpu_shares) {
  problems.push(
    `worker outweighs postgres on CPU (${services.worker.cpu_shares} > ${services.postgres.cpu_shares}); the embedding burst would starve the database it depends on`,
  );
}

const healthcheck = services.postgres?.healthcheck ?? {};
if (!` ${(healthcheck.test ?? []).join(' ')} `.includes(' -h ')) {
  problems.push('postgres healthcheck probes the UNIX socket while every client uses TCP');
}
if (!healthcheck.start_period) problems.push('postgres healthcheck has no start_period');

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Deployment limits and exposure check passed.');
