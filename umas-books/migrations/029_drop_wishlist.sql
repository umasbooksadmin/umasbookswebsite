-- The wishlist feature (public "notify me" requests + admin review) has
-- been retired. Drops the table it introduced in 011_wishlist.sql.
-- Not auto-applied — run manually once you've confirmed there's nothing
-- in wishlist_requests worth keeping.

DROP TABLE IF EXISTS wishlist_requests;
