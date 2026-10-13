# MongoDB Atlas Credential Rotation

## Scope

GitHub Secret Scanning currently has two open MongoDB Atlas URI alerts in this
repository: alert 1 points to `AutoReminder_Deployment_Guide.md` in an older
commit, and alert 4 points to `Backend/.env` in an older commit. The values are
not repeated here. Removing a secret from the current tree does not revoke it
or remove it from Git history.

The consolidated VA Dashboard uses MySQL and Redis; its Hetzner deployment
does not need the retired application's MongoDB URI. The Atlas screenshot
provided during this work showed one database user with `atlasAdmin` on all
resources. Verify the live Atlas project and all consumers before changing or
deleting that user: the same credential may still be used by another service.

## Rotation Procedure

1. In Atlas, select the organization and project, then open **Database &
   Network Access → Database Users**. Confirm the affected username and its
   roles. Atlas database users are separate from Atlas console users.
2. Inventory every service that may use this database user. Check deployed
   secret stores, running application configuration, scheduled jobs, and
   operator-owned projects. Record only the service, environment, secret
   reference, and migration status here or in an approved password manager;
   never record the password or full URI in this repository or chat.
3. If a consumer is still required, create a separate database user for that
   service. Select **Add New Database User → Password**, generate a unique
   password, grant only the required role on the required database, and
   restrict cluster access when the project supports it. Do not copy the old
   `atlasAdmin` privileges to an application user.
4. Put the new credential directly into that service's secret manager or
   protected server-side environment. Update and restart/redeploy one consumer
   at a time. Verify its real required reads and writes and inspect its logs
   before proceeding to the next consumer.
5. When every required consumer has been migrated, delete the exposed user in
   **Database & Network Access → Database Users**. If a complete inventory
   proves the retired user has no consumers, delete it without creating a
   replacement. Do not merely change the shared password while consumers are
   unknown; that can cause an outage without establishing least privilege.
6. Verify the old user no longer appears in Atlas and confirm each required
   service remains healthy. Then open GitHub **Security → Secret scanning** and
   close alerts 1 and 4 with the reason **revoked**. Do not close them before
   revocation is verified.
7. Keep the deployment inventory, verification date, and affected service
   names in the operational record. Never include credentials in that record.

To create or manage Atlas database users, an Atlas role with the required
project access is needed. Follow MongoDB's current
[Configure Database Users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/)
instructions for the UI and available roles.

## Completion Record

| Check | Status | Evidence / date |
| --- | --- | --- |
| All consumers of the exposed user inventoried | Not verified | |
| Required consumers migrated to scoped users | Not started | |
| Exposed Atlas user deleted or otherwise revoked | Not started | |
| Required services healthy after rotation | Not verified | |
| GitHub alerts 1 and 4 closed as revoked | Open | |
