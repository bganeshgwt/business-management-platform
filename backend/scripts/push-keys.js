// Makes a new key pair for alerts on a closed phone (Web Push) and prints the
// three lines for the server's backend/.env.
// Usage: npm run push:keys
//
// Make the keys once per server and keep them: every phone subscribed with
// the public key stops getting alerts when the pair changes, and has to turn
// alerts on again. The private key is a secret like JWT_SECRET: it goes in
// the server's .env only, never in git or a message. VAPID_SUBJECT is where a
// push service may write to the platform's operator about its messages.
const { generateKeys } = require("../src/modules/push/services/webPush");

const { publicKey, privateKey } = generateKeys();

process.stdout.write(
  [
    "# Alerts on a closed phone (Web Push): paste into backend/.env, then restart the API.",
    "# Keep the pair for as long as the server runs: a new pair stops every phone's alerts until it is turned on again.",
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    "VAPID_SUBJECT=mailto:alerts@your-domain.example",
    "",
  ].join("\n")
);
