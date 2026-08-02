import { createPrismaClient, readBootstrapSecret } from "@aihub/database";
import { hashLocalPassword, localPasswordIsValid } from "@aihub/security";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function stdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, "");
}

const username = (argument("--username") ?? "admin").trim().toLowerCase();
const displayName = (argument("--display-name") ?? "Local Administrator").trim();

if (!/^[a-z0-9._-]{1,64}$/.test(username) || displayName.length < 1 || displayName.length > 120) {
  throw new Error("The local administrator identity is invalid.");
}

const password = await stdinText();
if (!localPasswordIsValid(password)) {
  throw new Error("The temporary local administrator password is invalid.");
}

const prisma = createPrismaClient(readBootstrapSecret("aihub_database_url"));
try {
  const result = await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-local-admin:${username}`}, 0))`;
    const existing = await transaction.localAdministrator.findUnique({ where: { username } });
    if (existing) return { created: false, username: existing.username };

    const created = await transaction.localAdministrator.create({
      data: {
        username,
        displayName,
        passwordHash: await hashLocalPassword(password),
        role: "PLATFORM_ADMIN",
        passwordChangeRequired: true,
      },
    });
    await transaction.auditEvent.create({ data: {
      actorType: "SYSTEM",
      action: "administrator.local_account_provisioned",
      resourceType: "LocalAdministrator",
      resourceId: created.id,
      outcome: "SUCCESS",
      metadata: { username: created.username, requiresPasswordChange: true },
    } });
    return { created: true, username: created.username };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await prisma.$disconnect();
}
