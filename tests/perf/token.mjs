// Prints an access token for a demo user (for k6 and other tools): node tests/perf/token.mjs [user] [password]
import { token } from './oidc.mjs';

const [user = 'lead', pw = `${user}-demo`] = process.argv.slice(2);
console.log(await token(user, pw));
