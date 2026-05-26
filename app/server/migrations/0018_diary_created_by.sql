-- 0018_diary_created_by.sql
-- Adds an owner column to diary_entries so the app can enforce per-user
-- delete authorization: a non-admin may only delete snapshot entries that
-- they personally captured.
--
-- created_by = NULL  → auto-generated entry (narrator, timelapse, recap)
-- created_by = <user id> → manually triggered by that user (snapshot mutation)
--
-- ON DELETE SET NULL: if the user row is deleted the diary entry stays but
-- loses its ownership link, which is acceptable — an admin can still delete
-- the entry, and the orphaned snapshot won't be claimable by anyone else.

ALTER TABLE diary_entries ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
