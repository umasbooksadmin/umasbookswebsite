# Personal data breach log / Registre des violations de données

*GDPR article 33(5): every breach must be written down here, **even if it is not reported to the CNIL**.*

A breach is any incident where personal data is lost, stolen, sent to the wrong person, altered, or seen by someone who should not see it, whether by accident or on purpose. Examples: a stolen or hacked admin password; a laptop or phone with the inbox left unlocked and lost; a backup file or the GitHub backup repository made public; an email with a members list sent to the wrong address; the website's database exposed.

## Register / Registre

Add one row per incident (copy the template row). Keep this file private: do not put names or email addresses of the people affected here, only counts and categories.

| # | Date found (and date it happened) | What happened | Data affected (categories) | People affected (number, who) | Risk to them (none / low / high) and why | Actions taken | CNIL notified within 72 h? (y/n, date, reference) | People informed? (y/n, date, how) |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |

Example row, for illustration (not a real incident):

| E.g. | 2026-03-02 (happened 2026-03-01) | Volunteer sent the shift list to a wrong address | Names and emails of 6 volunteers | 6 volunteers | Low: one wrong recipient who has confirmed deletion | Asked recipient to delete; wrote to the 6 volunteers | n (low risk, reasoning recorded here) | y, 2026-03-02, email |

---

## What to do if you suspect a breach / Que faire en cas de suspicion

**The clock:** the association has **72 hours from the moment it becomes aware** of a breach to notify the CNIL, unless the breach is unlikely to put people's rights and freedoms at risk. Weekends count. If you are not sure, treat it as real and start the steps below. Notifying late is much worse than a notification that turns out not to be needed.

### 1. Act now (first hour)

- Write down the time you found out, and who told you what.
- **Stop the leak** if you can: change the password of the affected account (admin account, Gmail, Render, GitHub, HelloAsso, Backblaze); sign out all sessions; remove the wrong person's access; make the repository or bucket private again; turn off the lost device's access.
- If an admin account may be compromised: change its password and, in the website admin area (Members), deactivate that account until it is safe.
- If the database or a backup may have leaked: rotate the access keys (Render database password, GitHub tokens, Backblaze application key).

### 2. Tell people inside the association

- Tell the President and at least one other board member straight away. Contact: **admin@umasbooks.org**.
- One person leads and keeps notes (this file).

### 3. Preserve evidence (do not delete anything)

- Do **not** delete emails, logs, files or accounts, even the embarrassing ones.
- Take screenshots with the date and time visible: the alert email, the Render logs page, the GitHub or Backblaze access pages, the suspicious emails.
- Note exactly which data and which people could be involved (use the website admin: Members > **Download data (JSON)** shows what we hold for one person).
- Save the error alert emails (subject starting `[umas-books]`) and any message from a provider about the incident.

### 4. Decide: is there a risk to people?

- **No risk or unlikely risk** (for example the data was encrypted and the key was not lost, or one trusted person got it and deleted it): no CNIL notification needed, but **write it in the register above with your reasoning**.
- **Risk** (names, emails, phone numbers, order details or passwords in the wrong hands): notify the CNIL.
- **High risk** (for example data that enables fraud or harm, or passwords reused elsewhere): also **tell the people concerned**, clearly and quickly, without waiting for the end of the investigation.

### 5. Notify the CNIL (within 72 hours)

- Go to **cnil.fr** and search for "notifier une violation de données personnelles" (the online form, "Notifier une violation de données personnelles"). Fill in what you know now. The form lets you send complementary information later, so do not wait for a full picture.
- Have ready: the association's details (name, RNA W811011706, SIRET 109 441 147 00013, 5 rue Hippolyte Savary, 81000 Albi, admin@umasbooks.org), the date and nature of the breach, the kinds of data, the approximate number of people, the likely consequences, and what you have done.
- Keep the confirmation the CNIL sends (reference number) and write it in the register.

### 6. Inform people if required

- Write in plain French (and English where needed): what happened, what data, what they should do (for example change their password if they reuse it), what the association has done, and who to contact (admin@umasbooks.org).
- Send from the association's own mailbox, not from a personal one.

### 7. Afterwards

- Complete the register row (all columns).
- Report to the providers if the incident involves them, and check the processors list (`processors-checklist.md`).
- Fix the cause, and note what you changed.
- If a provider tells *us* it had a breach affecting our data, that starts our own 72-hour clock too: log it here.
