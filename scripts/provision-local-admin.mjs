#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const password = randomBytes(24).toString("base64url");
const command = spawnSync("docker", [
  "compose",
  "exec",
  "-T",
  "api",
  "node",
  "apps/api/dist/auth/provision-local-admin.js",
  "--username",
  "admin",
  "--display-name",
  "Local Administrator",
], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  input: password,
  windowsHide: true,
});

if (command.status !== 0) {
  process.stderr.write(command.stderr || "Local administrator provisioning failed.\n");
  process.exitCode = command.status ?? 1;
} else if (command.stdout.includes('"created":true')) {
  process.stdout.write(`Initial local administrator\n\nUsername: admin\nTemporary password: ${password}\n\nChange this password on first sign-in. It is not stored in plaintext by OrcaSynapse.\n`);
} else {
  process.stdout.write("The existing local administrator account was preserved.\n");
}
