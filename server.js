import 'dotenv/config';
import express from 'express';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, update, get, push } from 'firebase/database';
import { TelegramClient, Api } from 'telegram';
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

// ===== Load Telegram Accounts from .env =====
const accounts = [];
let i = 1;
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  accounts.push({
    phone: process.env[`TG_ACCOUNT_${i}_PHONE`],
    api_id: Number(process.env[`TG_ACCOUNT_${i}_API_ID`]),
    api_hash: process.env[`TG_ACCOUNT_${i}_API_HASH`],
    session: process.env[`TG_ACCOUNT_${i}_SESSION`],
    id: `TG_ACCOUNT_${i}`,
    floodWaitUntil: null
  });
  i++;
}

// ===== Check Telegram Account =====
async function checkTGAccount(account){
  try{
    const client = new TelegramClient(
      new StringSession(account.session),
      account.api_id,
      account.api_hash,
      { connectionRetries:5 }
    );
    await client.start({});
    await client.getMe();
    await update(ref(db, `accounts/${account.id}`), {
      status: "active",
      phone: account.phone,
      lastChecked: Date.now(),
      error: "",
      floodWaitUntil: null
    });
    await client.disconnect();
    return { id: account.id, status: "active" };
  }catch(err){
    let status = "error";
    let floodUntil = null;
    if(err.message.includes("FLOOD_WAIT")){
      status="floodwait";
      const m = err.message.match(/FLOOD_WAIT_(\d+)/);
      if(m) floodUntil = Date.now() + Number(m[1])*1000;
    }
    await update(ref(db, `accounts/${account.id}`), {
      status,
      phone: account.phone,
      lastChecked: Date.now(),
      error: err.message,
      floodWaitUntil: floodUntil
    });
    return { id: account.id, status, error: err.message, floodWaitUntil: floodUntil };
  }
}

// ===== Auto Check Accounts =====
const CHECK_INTERVAL = 60000;
async function autoCheck(){
  for(const acc of accounts){
    try{ await checkTGAccount(acc); console.log(`Checked ${acc.id}`); }
    catch(err){ console.log(`Error ${acc.id}: ${err.message}`); }
  }
}
setInterval(autoCheck,CHECK_INTERVAL);
autoCheck();

// ===== API Endpoints =====

// Get all accounts
app.get('/account-status', async (req,res)=>{
  const snapshot = await get(ref(db,'accounts'));
  res.json(snapshot.val() || {});
});

// Add single account
app.post('/add-account', async (req,res)=>{
  const { phone, api_id, api_hash, session } = req.body;
  if(!phone || !api_id || !api_hash || !session) return res.status(400).json({error:"All fields required"});
  const newId = `TG_ACCOUNT_${accounts.length+1}`;
  accounts.push({phone, api_id:Number(api_id), api_hash, session, id:newId, floodWaitUntil:null});
  await update(ref(db, `accounts/${newId}`), {
    phone, api_id:Number(api_id), api_hash, session,
    status:"pending", lastChecked:null, error:"", floodWaitUntil:null
  });
  res.json({success:true,id:newId});
});

// Upload multiple accounts via file content
app.post('/upload-accounts', async (req,res)=>{
  try{
    const { accounts:txt } = req.body;
    const lines = txt.split(/\r?\n/).filter(l=>l.trim());
    for(const line of lines){
      const [phone, api_id, api_hash, session] = line.split(",");
      if(!phone||!api_id||!api_hash||!session) continue;
      const newId = `TG_ACCOUNT_${accounts.length+1}`;
      accounts.push({phone, api_id:Number(api_id), api_hash, session, id:newId, floodWaitUntil:null});
      await update(ref(db, `accounts/${newId}`),{
        phone, api_id:Number(api_id), api_hash, session,
        status:"pending", lastChecked:null, error:"", floodWaitUntil:null
      });
    }
    res.json({success:true});
  }catch(err){ res.json({success:false,error:err.message}); }
});

// Fetch Members from a Telegram group
app.post('/members', async (req,res)=>{
  try{
    const { group } = req.body;
    if(!group) return res.status(400).json({error:"Group required"});
    const acc = accounts[0]; // use first account
    const client = new TelegramClient(new StringSession(acc.session),acc.api_id,acc.api_hash,{connectionRetries:5});
    await client.start({});
    const entity = await client.getEntity(group);
    const participants = await client.getParticipants(entity);
    const members = participants.map(p=>({
      user_id:p.id,
      username:p.username,
      avatar:p.photo?.small?.dc_id ? `https://t.me/i/userpic/320/${p.id}.jpg`:""
    }));
    await client.disconnect();
    res.json(members);
  }catch(err){ res.status(500).json({error:err.message}); }
});

// ===== Add Member Auto-Rotation + FloodWait Handling (Full Index Logic) =====
let accountIndex = 0;

app.post('/add-member', async (req,res)=>{
  try{
    const { username, user_id, targetGroup } = req.body;
    if(!targetGroup || (!username && !user_id)) return res.status(400).json({error:"Missing data"});

    // Rotate account safely with FloodWait skip
    let acc;
    let tried = 0;
    const totalAccounts = accounts.length;

    while(tried < totalAccounts){
      acc = accounts[accountIndex % totalAccounts];
      accountIndex++; // increment for next rotation
      tried++;

      // Skip if in FloodWait
      if(!acc.floodWaitUntil || acc.floodWaitUntil < Date.now()){
        break;
      }
    }

    if(tried >= totalAccounts){
      return res.status(429).json({error:"All accounts are in FloodWait, try later"});
    }

    const client = new TelegramClient(new StringSession(acc.session), acc.api_id, acc.api_hash, {connectionRetries:5});
    await client.start({});

    try{
      const targetEntity = await client.getEntity(targetGroup);
      const userEntity = await client.getEntity(username || user_id);

      // Detect type and add user
      if(targetEntity.className === 'Channel' || targetEntity.className === 'Chat') {
        await client.invoke(new Api.channels.InviteToChannel({
          channel: targetEntity,
          users: [userEntity]
        }));
      } else {
        await client.invoke(new Api.messages.AddChatUser({
          chatId: targetEntity.id,
          userId: userEntity,
          fwdLimit: 0
        }));
      }

      // Log success
      const histRef = push(ref(db,'history'));
      await update(histRef,{
        username, user_id, status:"success", accountUsed:acc.id, timestamp:Date.now()
      });
      await client.disconnect();
      res.json({status:"success", accountUsed:acc.id});

    }catch(errAdd){
      const histRef = push(ref(db,'history'));
      await update(histRef,{
        username, user_id, status:"failed", accountUsed:acc.id, error:errAdd.message, timestamp:Date.now()
      });
      await client.disconnect();
      res.json({status:"failed", accountUsed:acc.id, error:errAdd.message});
    }

  }catch(err){ res.status(500).json({error:err.message}); }
});

// Download history
app.get('/history', async (req,res)=>{
  const snapshot = await get(ref(db,'history'));
  res.json(snapshot.val() || []);
});

// Serve frontend
const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
app.get('/',(req,res)=> res.sendFile(path.join(__dirname,'index.html')));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
