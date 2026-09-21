-- ShivanshConnect is a B2C platform - leads are individual consumers, not
-- businesses, so the "company" field never applied and is being dropped
-- everywhere (schemas, routes, import/export, prompt variables, UI).
alter table leads drop column if exists company;
