import 'dotenv/config';
import express from 'express';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, update, get } from 'firebase/database';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

// ===== Firebase Config =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
};
initializeApp(firebaseConfig);
const db = getDatabase();

// ===== Load Telegram Accounts =====
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

// ===== Check Account Function =====
async function checkTGAccount(account){
  try {
    const client = new TelegramClient(
      new StringSession(account.session),
      account.api_id,
      account.api_hash,
      { connectionRetries: 5 }
    );
    await client.start({});
    await client.getMe();

    await update(ref(db, `accounts/${account.id}`), {
      status: "active",
      phone: account.phone,
      lastChecked: Date.now(),
      error: ""
    });

    await client.disconnect();
    return { id: account.id, status: "active" };
  } catch(err){
    let status = "error";
    if(err.message.includes("FLOOD_WAIT")) status = "floodwait";
    await update(ref(db, `accounts/${account.id}`), {
      status,
      phone: account.phone,
      lastChecked: Date.now(),
      error: err.message
    });
    return { id: account.id, status, error: err.message };
  }
}

// ===== Auto Collection =====
const CHECK_INTERVAL = 60000; // 60 seconds
async function autoCollect() {
  for(const acc of accounts){
    try{
      await checkTGAccount(acc);
      console.log(`Checked ${acc.id}`);
    } catch(err){
      console.log(`Error checking ${acc.id}: ${err.message}`);
    }
  }
}
setInterval(autoCollect, CHECK_INTERVAL);
autoCollect();

// ===== API =====
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

// ===== Add Account Endpoint =====
app.post('/add-account', async (req, res) => {
  const { phone, api_id, api_hash, session } = req.body;
  if(!phone || !api_id || !api_hash || !session){
    return res.status(400).json({ error: "All fields required" });
  }

  const newId = `TG_ACCOUNT_${accounts.length + 1}`;
  const newAccount = { phone, api_id: Number(api_id), api_hash, session, id: newId };
  accounts.push(newAccount);

  await update(ref(db, `accounts/${newId}`), {
    phone, api_id: Number(api_id), api_hash, session,
    status: "pending", lastChecked: null, error: ""
  });

  res.json({ success: true, id: newId });
});

// ===== Serve index.html =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
