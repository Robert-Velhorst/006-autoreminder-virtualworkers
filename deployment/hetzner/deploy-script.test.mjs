import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("./deploy.sh", import.meta.url), "utf8");

test("deployment failures before Compose promotion preserve the running app", () => {
  const rollback = script.slice(
    script.indexOf("rollback() {"),
    script.indexOf("trap rollback - ERR")
  );
  const guard = rollback.indexOf('if [[ "$compose_promoted" != true ]]');
  const restore = rollback.indexOf('cp -p "$previous_compose" "$compose_file"');
  const remove = rollback.indexOf(
    'docker compose --env-file "$APP_DIR/.env" -f "$compose_file" rm --stop --force app'
  );

  assert.notEqual(guard, -1, "rollback has a pre-activation guard");
  assert.ok(
    guard < restore,
    "pre-activation failures cannot restore or restart the old app"
  );
  assert.ok(
    guard < remove,
    "pre-activation failures cannot remove an app container"
  );
  assert.match(
    rollback.slice(guard),
    /rm -f "\$COMPOSE_CANDIDATE"[\s\S]*exit "\$status"/
  );
});

test("rollback becomes eligible only after the candidate Compose file is promoted", () => {
  const promotion = script.indexOf('mv "$COMPOSE_CANDIDATE" "$compose_file"');
  const markPromoted = script.indexOf("compose_promoted=true", promotion);
  const pull = script.indexOf(
    'docker compose --env-file "$APP_DIR/.env" -f "$compose_file" pull app',
    markPromoted
  );

  assert.notEqual(promotion, -1);
  assert.ok(
    markPromoted > promotion,
    "promotion state is set after the atomic move"
  );
  assert.ok(
    pull > markPromoted,
    "pull and activation failures trigger rollback"
  );
});
