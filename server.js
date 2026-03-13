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

/* ================= FIREBASE ================= */

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
};

initializeApp(firebaseConfig);
const db = getDatabase();

/* ================= LOAD TELEGRAM ACCOUNTS ================= */

const accounts = [];
let i = 1;

while(process.env[`TG_ACCOUNT_${i}_PHONE`]){

  accounts.push({
    phone: process.env[`TG_ACCOUNT_${i}_PHONE`],
    api_id: Number(process.env[`TG_ACCOUNT_${i}_API_ID`]),
    api_hash: process.env[`TG_ACCOUNT_${i}_API_HASH`],
    session: process.env[`TG_ACCOUNT_${i}_SESSION`],
    id:`TG_ACCOUNT_${i}`
  });

  i++;
}

/* ================= CHECK TELEGRAM ACCOUNT ================= */

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

    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      phone:account.phone,
      lastChecked:Date.now(),
      floodWaitUntil:null
    });

    await client.disconnect();

  }catch(err){

    let status="error";
    let floodUntil=null;

    if(err.message.includes("FLOOD_WAIT")){

      status="floodwait";

      const m = err.message.match(/FLOOD_WAIT_(\d+)/);

      if(m){
        floodUntil = Date.now() + Number(m[1])*1000;
      }
    }

    await update(ref(db,`accounts/${account.id}`),{
      status,
      phone:account.phone,
      error:err.message,
      lastChecked:Date.now(),
      floodWaitUntil:floodUntil
    });

  }

}

/* ================= AUTO ACCOUNT CHECK ================= */

async function autoCheck(){

  for(const acc of accounts){
    await checkTGAccount(acc);
  }

}

setInterval(autoCheck,60000);
autoCheck();

/* ================= ACCOUNT STATUS ================= */

app.get('/account-status', async(req,res)=>{
  const snap = await get(ref(db,'accounts'));
  res.json(snap.val() || {});
});

/* ================= EXPORT MEMBERS ================= */

app.post('/members', async(req,res)=>{

  try{

    const { group } = req.body;

    const acc = accounts[0];

    const client = new TelegramClient(
      new StringSession(acc.session),
      acc.api_id,
      acc.api_hash,
      { connectionRetries:5 }
    );

    await client.start({});

    const entity = await client.getEntity(group);

    const participants = await client.getParticipants(entity,{limit:2000});

    const members = participants.map(p=>({
      user_id:p.id,
      access_hash:p.accessHash,
      username:p.username,
      avatar:`https://t.me/i/userpic/320/${p.id}.jpg`
    }));

    await client.disconnect();

    res.json(members);

  }catch(err){

    res.status(500).json({ error:err.message });

  }

});

/* ================= ADD MEMBER SYSTEM ================= */

let accountIndex = 0;

app.post('/add-member', async(req,res)=>{

  try{

    const { username, user_id, access_hash, targetGroup } = req.body;

    const acc = accounts[accountIndex % accounts.length];

    const client = new TelegramClient(
      new StringSession(acc.session),
      acc.api_id,
      acc.api_hash,
      { connectionRetries:5 }
    );

    await client.start({});

    const group = await client.getEntity(targetGroup);

    let user;

    /* ===== CREATE USER ===== */

    if(access_hash){

      user = new Api.InputUser({
        userId:user_id,
        accessHash:access_hash
      });

    }else{

      user = username
        ? await client.getEntity(username)
        : await client.getEntity(user_id);

    }

    /* ===== CHECK IF MEMBER ===== */

    try{

      await client.invoke(
        new Api.channels.GetParticipant({
          channel:group,
          participant:user
        })
      );

      await push(ref(db,'history'),{
        username,
        user_id,
        status:"skipped",
        reason:"already_in_group",
        accountUsed:acc.id,
        timestamp:Date.now()
      });

      await client.disconnect();

      return res.json({
        status:"skipped",
        reason:"already_in_group",
        accountUsed:acc.id
      });

    }catch(e){
      // continue invite
    }

    /* ===== INVITE MEMBER ===== */

    try{

      await client.invoke(
        new Api.channels.InviteToChannel({
          channel:group,
          users:[user]
        })
      );

    }catch(inviteError){

      const reason = inviteError.message;

      await push(ref(db,'history'),{
        username,
        user_id,
        status:"failed",
        reason,
        accountUsed:acc.id,
        timestamp:Date.now()
      });

      await client.disconnect();

      return res.json({
        status:"failed",
        reason,
        accountUsed:acc.id
      });

    }

    /* ===== VERIFY JOIN ===== */

    let joined=false;

    try{

      await client.invoke(
        new Api.channels.GetParticipant({
          channel:group,
          participant:user
        })
      );

      joined=true;

    }catch(e){
      joined=false;
    }

    if(joined){

      await push(ref(db,'history'),{
        username,
        user_id,
        status:"success",
        accountUsed:acc.id,
        timestamp:Date.now()
      });

      accountIndex = (accountIndex + 1) % accounts.length;

      await client.disconnect();

      return res.json({
        status:"success",
        accountUsed:acc.id
      });

    }else{

      await push(ref(db,'history'),{
        username,
        user_id,
        status:"failed_not_joined",
        reason:"invite_sent_but_not_joined",
        accountUsed:acc.id,
        timestamp:Date.now()
      });

      await client.disconnect();

      return res.json({
        status:"failed_not_joined",
        accountUsed:acc.id
      });

    }

  }catch(err){

    await push(ref(db,'history'),{
      status:"error",
      reason:err.message,
      timestamp:Date.now()
    });

    res.status(500).json({ error:err.message });

  }

});

/* ================= HISTORY ================= */

app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'));
  res.json(snap.val() || {});
});

/* ================= FRONTEND ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get('/',(req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
  console.log("🚀 Telegram Add Member Server Running:",PORT);
});
