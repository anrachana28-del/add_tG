import 'dotenv/config';
import express from 'express';
import { initializeApp } from "firebase/app";
import { getDatabase, ref, update, get } from "firebase/database";
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

// ===== Firebase Config =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL,
};
const appFirebase = initializeApp(firebaseConfig);
const db = getDatabase(appFirebase);

// ===== Load TG accounts from .env dynamically =====
const accounts = [];
let i = 1;
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  accounts.push({
    phone: process.env[`TG_ACCOUNT_${i}_PHONE`],
    api_id: Number(process.env[`TG_ACCOUNT_${i}_API_ID`]),
    api_hash: process.env[`TG_ACCOUNT_${i}_API_HASH`],
    session: process.env[`TG_ACCOUNT_${i}_SESSION`],
    id: `TG_ACCOUNT_${i}`
  });
  i++;
}

// ===== Check TG Account FloodWait =====
async function checkTGAccount(account){
  try{
    const client = new TelegramClient(
      new StringSession(account.session),
      account.api_id,
      account.api_hash,
      { connectionRetries: 5 }
    );

    await client.start({
      phoneNumber: async () => account.phone,
      password: async () => input.text('2FA Password (if any): '),
      phoneCode: async () => input.text('Code: '),
      onError: console.log
    });

    await client.getMe();

    await update(ref(db, `accounts/${account.id}`), {
      status: "active",
      phone: account.phone,
      lastChecked: Date.now()
    });

    await client.disconnect();
    return { id: account.id, status: "active" };

  } catch(err){
    console.log(err.message);
    if(err.message.includes("FLOOD_WAIT")){
      await update(ref(db, `accounts/${account.id}`), {
        status: "floodwait",
        phone: account.phone,
        lastChecked: Date.now()
      });
      return { id: account.id, status: "floodwait" };
    }
    await update(ref(db, `accounts/${account.id}`), {
      status: "error",
      phone: account.phone,
      lastChecked: Date.now()
    });
    return { id: account.id, status: "error", error: err.message };
  }
}

// ===== API endpoints =====
app.get('/check-accounts', async (req, res) => {
  const results = [];
  for(const acc of accounts){
    const result = await checkTGAccount(acc);
    results.push(result);
  }
  res.json(results);
});

app.get('/account-status', async (req, res) => {
  const snapshot = await get(ref(db, 'accounts'));
  res.json(snapshot.val() || {});
});

// ===== Serve index.html from root =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(process.env.PORT || 3000, () => console.log('Server running on http://localhost:3000'));