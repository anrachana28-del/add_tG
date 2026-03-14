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

// ===== Firebase =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
};
initializeApp(firebaseConfig);
const db = getDatabase();

// ===== Load Accounts =====
const accounts = [];
let i = 1;
while (process.env[`TG_ACCOUNT_${i}_PHONE`]) {
  accounts.push({
    phone: process.env[`TG_ACCOUNT_${i}_PHONE`],
    api_id: Number(process.env[`TG_ACCOUNT_${i}_API_ID`]),
    api_hash: process.env[`TG_ACCOUNT_${i}_API_HASH`],
    session: process.env[`TG_ACCOUNT_${i}_SESSION`],
    id: `TG_ACCOUNT_${i}`,
    status: 'pending',
    floodWaitUntil: null
  });
  i++;
}

// ===== Check Telegram Account =====
async function checkTGAccount(account){
  try{
    const client = new TelegramClient(new StringSession(account.session), account.api_id, account.api_hash, { connectionRetries:5 });
    await client.start({});
    await client.getMe();
    await update(ref(db, `accounts/${account.id}`), {
      status:"active",
      phone:account.phone,
      lastChecked:Date.now(),
      floodWaitUntil:null
    });
    await client.disconnect();
  }catch(err){
    let status="error", floodUntil=null;
    if(err.message.includes("FLOOD_WAIT")){
      status="floodwait";
      const m = err.message.match(/FLOOD_WAIT_(\d+)/);
      if(m) floodUntil = Date.now() + Number(m[1])*1000;
    }
    await update(ref(db, `accounts/${account.id}`),{
      status, phone:account.phone, error:err.message, lastChecked:Date.now(), floodWaitUntil:floodUntil
    });
  }
}

// ===== Auto Check =====
async function autoCheck(){
  for(const acc of accounts){
    await checkTGAccount(acc);
  }
}
setInterval(autoCheck,60000);
autoCheck();

// ===== API Routes =====

// Get all accounts
app.get('/account-status', async (req,res)=>{
  const snap = await get(ref(db,'accounts'));
  res.json(snap.val() || {});
});

// Add single account
app.post('/add-account', async(req,res)=>{
  try{
    const { phone, api_id, api_hash, session } = req.body;
    const id = `TG_ACCOUNT_${accounts.length+1}`;
    accounts.push({ phone, api_id:Number(api_id), api_hash, session, id });
    await update(ref(db, `accounts/${id}`), {
      phone, api_id:Number(api_id), api_hash, session,
      status:"pending", lastChecked:null, floodWaitUntil:null
    });
    res.json({ success:true, id });
  }catch(err){ res.json({ success:false, error:err.message }); }
});

// Upload multiple accounts
app.post('/upload-accounts', async(req,res)=>{
  try{
    const { accounts:txt } = req.body;
    const lines = txt.split(/\r?\n/).filter(l=>l.trim());
    for(const line of lines){
      const [phone, api_id, api_hash, session] = line.split(",");
      if(!phone||!api_id||!api_hash||!session) continue;
      const id = `TG_ACCOUNT_${accounts.length+1}`;
      accounts.push({ phone, api_id:Number(api_id), api_hash, session, id });
      await update(ref(db, `accounts/${id}`),{
        phone, api_id:Number(api_id), api_hash, session,
        status:"pending", lastChecked:null, floodWaitUntil:null
      });
    }
    res.json({ success:true });
  }catch(err){ res.json({ success:false, error:err.message }); }
});

// Fetch Members
app.post('/members', async(req,res)=>{
  try{
    const { group } = req.body;
    const now = Date.now();
   const acc = accounts.find(a => !a.floodWaitUntil || a.floodWaitUntil < now);
   if(!acc){
              return res.status(500).json({error:"All accounts in FloodWait"});
            }
    const client = new TelegramClient(new StringSession(acc.session), acc.api_id, acc.api_hash, {connectionRetries:5});
    await client.start({});
    const entity = await client.getEntity(group);
    const participants = await client.getParticipants(entity,{limit:2000});
    const members = participants
  .filter(p => !p.bot)
  .map(p=>({
    user_id:p.id,
    username:p.username,
    avatar:`https://t.me/i/userpic/320/${p.id}.jpg`
  }));
    await client.disconnect();
    res.json(members);
  }catch(err){ res.status(500).json({ error:err.message }); }
});

// Add Member with rotation, FloodWait handling & verification
let accountIndex = 0;
app.post('/add-member', async(req,res)=>{
  try{
    const { username, user_id, targetGroup, accountId } = req.body;
    const now = Date.now();

    // Filter accounts that are not in FloodWait
    let activeAccounts = accounts.filter(a=>!a.floodWaitUntil || a.floodWaitUntil < now);
    if(activeAccounts.length===0){
      return res.json({ status:"all_floodwait", reason:"All accounts in FloodWait" });
    }

    let acc;
    if(accountId){
      acc = accounts.find(a=>a.id===accountId);
    } else {
      acc = activeAccounts[accountIndex % activeAccounts.length];
      accountIndex++;
    }

    const client = new TelegramClient(new StringSession(acc.session), acc.api_id, acc.api_hash, {connectionRetries:5});
    await client.start({});

    const group = await client.getEntity(targetGroup);
    let user = username ? await client.getEntity(username) : await client.getEntity(user_id);

    let status = "failed_not_joined", reason="unknown";

    try{
      await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [user] }));
      // Delay 5 seconds
        const delay = Math.floor(Math.random()*5000)+5000;
        await new Promise(r => setTimeout(r, delay));
      // Verify if actually joined
      const participants = await client.getParticipants(group,{limit:2000});
      const joined = participants.some(p => p.id===user.id);

      if(joined){
        status="success";
        reason="joined";
      } else {
        status="failed_not_joined";
        reason="User did not join";
      }

   }catch(errAdd){

  if(errAdd.message.includes("USER_ALREADY_PARTICIPANT")){
    status="failed";
    reason="Already member";
  }

  else if(errAdd.message.includes("USER_PRIVACY_RESTRICTED")){
    status="failed";
    reason="User privacy restricted";
  }

  else if(errAdd.message.includes("PEER_FLOOD")){
    status="failed";
    reason="Peer flood limit";
  }

  else if(errAdd.message.includes("FLOOD_WAIT")){
    const m = errAdd.message.match(/FLOOD_WAIT_(\d+)/);

    if(m){
      const waitSeconds = Number(m[1]);
      const floodUntil = Date.now() + waitSeconds*1000;

      acc.floodWaitUntil = floodUntil;
      acc.status="floodwait";

      const floodDate = new Date(floodUntil);
      const floodDateStr = floodDate.toLocaleString();

      await update(ref(db,`accounts/${acc.id}`),{
        status:"floodwait",
        floodWaitUntil:floodUntil,
        floodWaitDate:floodDateStr
      });

      status="failed";
      reason=`FloodWait until ${floodDateStr}`;
    }
  }

  else{
    status="failed";
    reason=errAdd.message;
  }

}

    await push(ref(db,'history'),{ username, user_id, status, accountUsed:acc.id, reason, timestamp:Date.now() });
    await client.disconnect();
    res.json({ status, accountUsed:acc.id, reason });
  }catch(err){ res.status(500).json({ error:err.message }); }
});

// History
app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'));
  res.json(snap.val() || {});
});

// Serve frontend
const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`🚀 Server running on port ${PORT}`));
