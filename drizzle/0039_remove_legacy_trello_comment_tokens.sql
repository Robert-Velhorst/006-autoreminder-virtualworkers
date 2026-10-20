-- The dashboard never consumed these per-worker tokens. Remove the dormant
-- secret store rather than leaving credentials that cannot affect posting.
DELETE FROM `app_settings` WHERE `key` = 'trello_comment_token';
