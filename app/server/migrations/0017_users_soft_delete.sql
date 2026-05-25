-- 0017_users_soft_delete.sql
-- Adds soft-delete support so that an admin-deleted user can be re-added
-- with the same email without creating a duplicate Zyphr account.
--
-- deleted_at = NULL  → active
-- deleted_at = <epoch-ms> → soft-deleted; invisible to login/listing paths
--
-- The existing UNIQUE constraint on email and zyphr_user_id is intentionally
-- preserved: a soft-deleted row still holds both values so the reactivation
-- path can find it by email and re-attach to the same Zyphr account.
-- Because the constraint spans all rows (active AND deleted), only one row
-- per email can exist at any time, which is correct — if you need two
-- different people to share an email address you have bigger problems.

ALTER TABLE users ADD COLUMN deleted_at INTEGER DEFAULT NULL;
