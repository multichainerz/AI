# Session attachments to Hermes

v9.7.1 injects this-turn Session images on the Hermes native-session POST.
PNG, JPEG, GIF, and WebP bound to the user message ride as `image_url` /
`data:image` parts. Hermes persist stores `[screenshot]`; later turns and
native forks replay that placeholder, not pixels. Re-attach to show an
image again.

The same tag inlines small this-turn UTF-8 (plain text, Markdown, CSV, JSON
under 16,384 bytes) as extra text parts, skip-and-labelled against the
combined persist bound. There is no session inbox, no VM2 disk write of
user files, and no `read_file` token in ATTACHED FILES.
