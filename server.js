import 'dotenv/config';
import express from 'express';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, update, get, push } from 'firebase/database';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';
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

// ===== Auto Check Accounts =====
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
  }catch(err){
    let status = "error";
    let floodUntil = null;
    if(err.message.includes("FLOOD_WAIT")){
      status = "floodwait";
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
  }
}

// Auto check interval
setInterval(()=>accounts.forEach(acc=>checkTGAccount(acc)),60000);
accounts.forEach(acc=>checkTGAccount(acc));

// ===== API =====

// Fetch members
app.post('/members', async (req,res)=>{
  try{
    const { group } = req.body;
    if(!group) return res.status(400).json({error:"Group required"});
    const acc = accounts[0];
    const client = new TelegramClient(new StringSession(acc.session), acc.api_id, acc.api_hash, {connectionRetries:5});
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

// ===== Add member with rotation + delay 20s =====
let accountIndex = 0;

app.post('/add-member', async (req,res)=>{
  try{
    const { members, targetGroup } = req.body;
    if(!targetGroup || !members || !Array.isArray(members) || members.length===0)
      return res.status(400).json({error:"Missing data"});
    
    const results = [];

    for(const member of members){
      const acc = accounts[accountIndex % accounts.length];
      accountIndex++;
      const client = new TelegramClient(new StringSession(acc.session), acc.api_id, acc.api_hash, {connectionRetries:5});
      await client.start({});
      try{
        const entity = await client.getEntity(targetGroup);
        let userEntity;
        if(member.username){
          userEntity = await client.getEntity(member.username);
        } else {
          userEntity = await client.getEntity(member.user_id);
        }
        // Invite member to channel/group
        await client.invoke(
          new Api.channels.InviteToChannel({ channel: entity, users: [userEntity] })
        );

        // Log success
        const histRef = push(ref(db,'history'));
        await update(histRef,{
          username: member.username,
          user_id: member.user_id,
          status:"success",
          accountUsed: acc.id,
          timestamp: Date.now()
        });

        results.push({ ...member, status:"success", accountUsed: acc.id });
      }catch(errAdd){
        const histRef = push(ref(db,'history'));
        await update(histRef,{
          username: member.username,
          user_id: member.user_id,
          status:"failed",
          accountUsed: acc.id,
          error: errAdd.message,
          timestamp: Date.now()
        });
        results.push({ ...member, status:"failed", accountUsed: acc.id, error: errAdd.message });
      }
      await client.disconnect();
      // Wait 20 seconds before next account/member
      await new Promise(r=>setTimeout(r,20000));
    }

    res.json({ results });
  }catch(err){ res.status(500).json({error:err.message}); }
});

// ===== Download history =====
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
