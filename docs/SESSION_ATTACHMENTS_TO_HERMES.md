# Session attachments to Hermes

v9.7.2 copies each Session upload onto the Hermes node under
`/var/lib/orcasynapse-hermes/artifacts/<sessionId>/inbox/` before the turn
starts. Native `file` tools (`read_file`, `write_file`, `patch`, `search_files`)
are in the enrolment baseline so the agent can edit that blob. The artifact
publisher skips `inbox/` so those files are not echoed back as agent
deliverables. Save a copy the user should keep under the session deliverables
directory.

This-turn PNG/JPEG/GIF/WebP still ride the Hermes POST as `image_url` /
`data:image` parts (later turns persist `[screenshot]`). Small this-turn UTF-8
still inlines as extra text. There is no session-inbox companion besides the
existing publisher binary serving `--serve-inbox` on TCP/8643 with the Hermes
API key.
