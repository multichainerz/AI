import { eq } from "drizzle-orm";
import {
  auditEvent,
  createDrizzleClient,
  localAdministrator,
  localUser,
  readBootstrapSecret,
} from "@orcasynapse/database";
import { hashLocalPassword, localPasswordIsValid } from "@orcasynapse/security";
import { advisoryLock } from "../database-support.js";

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

const { database, close } = createDrizzleClient(readBootstrapSecret("orcasynapse_database_url"));
try {
  const result = await database.transaction(async (transaction) => {
    await transaction.execute(advisoryLock(`orcasynapse-local-admin:${username}`));
    const [existing] = await transaction
      .select({ username: localAdministrator.username })
      .from(localAdministrator)
      .where(eq(localAdministrator.username, username))
      .limit(1);
    if (existing) return { created: false, username: existing.username };

    const [person] = await transaction
      .select({ id: localUser.id })
      .from(localUser)
      .where(eq(localUser.username, username))
      .limit(1);
    if (person) {
      throw new Error("That username is already a person account. Choose a different administrator username.");
    }

    const [created] = await transaction
      .insert(localAdministrator)
      .values({
        username,
        displayName,
        passwordHash: await hashLocalPassword(password),
        role: "PLATFORM_ADMIN",
        passwordChangeRequired: true,
      })
      .returning({ id: localAdministrator.id, username: localAdministrator.username });
    if (!created) throw new Error("The local administrator account could not be provisioned.");

    await transaction.insert(auditEvent).values({
      actorType: "SYSTEM",
      action: "administrator.local_account_provisioned",
      resourceType: "LocalAdministrator",
      resourceId: created.id,
      outcome: "SUCCESS",
      metadata: { username: created.username, requiresPasswordChange: true },
    });
    return { created: true, username: created.username };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await close();
}
