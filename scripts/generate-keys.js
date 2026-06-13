// Run once to mint VAPID keys for web push. Output goes into .env.
import webpush from "web-push";
const keys = webpush.generateVAPIDKeys();
console.log("# Add these to .env (or docker-compose environment):\n");
console.log(`VAPID_PUBLIC=${keys.publicKey}`);
console.log(`VAPID_PRIVATE=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@yourdomain.com`);
