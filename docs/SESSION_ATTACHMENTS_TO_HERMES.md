# Session attachments to Hermes

v9.7.2 copies each Session upload onto the Hermes node under
`/var/lib/orcasynapse-hermes/artifacts/<sessionId>/inbox/` before the turn
starts. Native `file` tools (`read_file`, `write_file`, `patch`, `search_files`)
are in the enrolment baseline so the agent can edit that blob. The artifact
publisher skips `inbox/` so those files are not echoed back as agent
deliverables. Save a copy the user should keep under the session deliverables
directory.

The Hermes POST is the typed prompt only. Images and text are not inlined on
the wire; the agent opens the inbox path with native file tools.
