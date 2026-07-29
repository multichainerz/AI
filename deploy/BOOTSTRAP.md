# AIHub Bootstrap

AIHub requires three trust anchors before its database-backed configuration vault can open:

- the PostgreSQL connection string;
- the 32-byte vault master key;
- an initial administrator setup token.

For the local Compose deployment, generate these files with:

```bash
node scripts/generate-bootstrap.mjs
```

The command also generates the PostgreSQL password and writes the four generated values under `.local/secrets`. That directory is ignored by Git. The generator performs a full preflight check and refuses to overwrite existing secrets.

The generator does not print the administrator token into terminal or deployment logs. Retrieve `.local/secrets/aihub_bootstrap_token` through an approved local secret-reading workflow when the unlock screen requires it.

Start the local stack with:

```bash
docker compose up --build
```

For Coolify, create equivalent mounted secrets named:

- `postgres_password`
- `aihub_database_url`
- `aihub_master_key`
- `aihub_bootstrap_token`

Do not paste these values into repository files. Enter the setup token only into the AIHub unlock screen over an approved TLS connection. It creates a server-side session and is not sent on later administration requests. The bootstrap token must be rotated or retired after enterprise identity is configured. Back up the database URL and master key through MPM's approved secure recovery process. Losing the master key makes encrypted connector credentials unrecoverable.

After the first successful start, supported service endpoints, API keys, model aliases, operational settings, and connectors are entered through AIHub rather than added to deployment environment files. Private-CA certificate lifecycle support remains an explicit Phase 1 target-environment requirement.
