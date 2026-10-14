-- Quiz anything: explicit table privileges.
-- Run after 001_init.sql. Safe whether or not "Automatically expose new tables" is on:
-- the server's service role gets what it needs, and the public roles get nothing,
-- so access doesn't depend on RLS alone.

grant select, insert, update, delete on questions, usage_daily, rate_limits to service_role;

revoke all on questions, usage_daily, rate_limits from anon, authenticated;
