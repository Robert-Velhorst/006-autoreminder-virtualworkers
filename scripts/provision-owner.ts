import { runOwnerProvisioningCli } from "../server/ownerProvisioning";

// Intentionally no dotenv or server import: use only the operator's private environment.
process.exitCode = await runOwnerProvisioningCli(process.argv.slice(2));
