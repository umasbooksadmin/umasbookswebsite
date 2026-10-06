# Manual test scripts

These are step-by-step checklists for testing the whole website by hand before launch, one script for each of the five kinds of user (guest, account holder, member, volunteer, admin), plus edge cases. They are written for a non-developer.
To use them, open `manual-test-scripts.md`, read "Before you start", then work through one script at a time: tick each `[ ]`, compare what you see with "You should see", and write failures in the results table at the end.
Do the steps marked **(must)** first; they cover the money, legal and login paths. Re-run the scripts after any big change, and before turning preview mode off (runbook section g).

## Automated version

Most of the same steps also run by themselves: `umas-books/e2e/` holds automated end-to-end tests named with the step ids of these scripts (`G12`, `AC22`, `M5`, `VO3`, `A9`...; the table at the top of the manual script maps the old ids to the new ones), and the steps a computer cannot do (e-mail links, the HelloAsso membership payment, judging by eye) are listed there as manual-only. They run against a running site by its address, for example `E2E_BASE_URL=https://umasbooks.org npm run e2e`, and refuse to run unless the site is on your own computer, in preview mode, or you say so on purpose. They never pay (books and seats are only reserved, and nothing is paid online for them). See `umas-books/e2e/README.md` for plain-language instructions, what each kind of user needs, and how to read the report. Run them before the manual scripts, then do the manual-only steps by hand.
