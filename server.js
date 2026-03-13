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

/* ================= LOAD ACCOUNTS ================= */

const accounts = [];
let i = 1;

while (process.env[`TG_ACCOUNT_${i}_PHONE`]) {

  accounts.push({
    phone: process.env[`TG_ACCOUNT_${i}_PHONE`],
    api_id: Number(process.env[`TG_ACCOUNT_${i}_API_ID`]),
    api_hash: process.env[`TG_ACCOUNT_${i}_API_HASH`],
    session: process.env[`TG_ACCOUNT_${i}_SESSION`],
    id: `TG_ACCOUNT_${i}`
  });

  i++;
}

/* ================= ACCOUNT CHECK ================= */

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

      if(m) floodUntil = Date.now() + Number(m[1])*1000;
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

/* ================= AUTO CHECK ================= */

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

/* ================= FETCH MEMBERS ================= */

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

/* ================= ADD MEMBER ================= */

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

    /* ===== SUPPORT ID + ACCESS HASH ===== */

    if(access_hash){

      user = new Api.InputUser({
        userId: user_id,
        accessHash: access_hash
      });

    }else{

      user = username
        ? await client.getEntity(username)
        : await client.getEntity(user_id);

    }

    /* ===== CHECK MEMBER EXIST ===== */

    try{

      await client.invoke(
        new Api.channels.GetParticipant({
          channel: group,
          participant: user
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
        accountUsed:acc.id
      });

    }catch(e){
      // not member → continue
    }

    /* ===== ADD MEMBER ===== */

    try{

      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: group,
          users:[user]
        })
      );

      await push(ref(db,'history'),{
        username,
        user_id,
        status:"success",
        accountUsed:acc.id,
        timestamp:Date.now()
      });

      await client.disconnect();

      /* rotate account only success */

      accountIndex = (accountIndex + 1) % accounts.length;

      res.json({
        status:"success",
        accountUsed:acc.id
      });

    }catch(errAdd){

      if(errAdd.message.includes("FLOOD_WAIT")){

        const m = errAdd.message.match(/FLOOD_WAIT_(\d+)/);

        if(m){

          const floodUntil = Date.now() + Number(m[1])*1000;

          await update(ref(db,`accounts/${acc.id}`),{
            status:"floodwait",
            floodWaitUntil:floodUntil
          });

        }

      }

      await push(ref(db,'history'),{
        username,
        user_id,
        status:"failed",
        accountUsed:acc.id,
        error:errAdd.message,
        timestamp:Date.now()
      });

      await client.disconnect();

      res.json({
        status:"failed",
        accountUsed:acc.id,
        error:errAdd.message
      });

    }

  }catch(err){

    res.status(500).json({ error:err.message });

  }

});

/* ================= HISTORY ================= */

app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'));
  res.json(snap.val() || {});
});

/* ================= SERVE FRONTEND ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

/* ================= START SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
  console.log(`🚀 Server running on port ${PORT}`);
});
