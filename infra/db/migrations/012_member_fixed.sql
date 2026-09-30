-- S6: a campaign member's repair was confirmed FIXED (a campaign closes only when every member is).
ALTER TABLE core.campaign_member ADD COLUMN fixed boolean NOT NULL DEFAULT false;
