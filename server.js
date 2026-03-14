import 'dotenv/config';
import express from 'express';
import { initializeApp } from "firebase/app";
import { getDatabase, ref, update, get, push } from "firebase/database";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const app = express();
app.use(express.json());

// Firebase config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL,
  projectId: process.env.FIREBASE_PROJECT_ID
};
const fbApp = initializeApp(firebaseConfig);
const db = getDatabase(fbApp);

let clients = {};

// Auto reset FloodWait expired accounts every 5 sec
setInterval(async () => {
  const snapshot = await get(ref(db, 'accounts'));
  const now = Date.now();
  snapshot.forEach(async accSnap => {
    const acc = accSnap.val();
    if(acc.status === "floodwait" && acc.floodWaitUntil <= now){
      await update(ref(db, `accounts/${accSnap.key}`), { status: "active", floodWaitUntil: null });
    }
  });
}, 5000);

// Helper: get Telegram client
async function getClient(acc){
  if(clients[acc.id]) return clients[acc.id];
  const client = new TelegramClient(
    new StringSession(acc.session),
    acc.api_id,
    acc.api_hash,
    { connectionRetries:5 }
  );
  await client.start({});
  clients[acc.id] = client;
  return client;
}

// API: Account status
app.get('/account-status', async (req,res)=>{
  const snapshot = await get(ref(db,'accounts'));
  res.json(snapshot.val() || {});
});

// API: Add account
app.post('/add-account', async (req,res)=>{
  const { phone, api_id, api_hash, session } = req.body;
  if(!phone || !api_id || !api_hash || !session) return res.json({ success:false });
  const id = phone.replace(/\D/g,''); // use phone as id
  await update(ref(db, `accounts/${id}`), { phone, api_id, api_hash, session, status:"active" });
  res.json({ success:true });
});

// API: Upload multiple accounts
app.post('/upload-accounts', async (req,res)=>{
  const { accounts } = req.body;
  const lines = accounts.split("\n");
  for(const line of lines){
    const [phone, api_id, api_hash, session] = line.split(",");
    if(phone && api_id && api_hash && session){
      const id = phone.replace(/\D/g,'');
      await update(ref(db, `accounts/${id}`), { phone, api_id, api_hash, session, status:"active" });
    }
  }
  res.json({ success:true });
});

// API: Get members of a group
app.post('/members', async (req,res)=>{
  const { group } = req.body;
  // return mock members for testing
  const members = Array.from({length:10}, (_,i)=>({ username:`user${i+1}`, user_id:1000+i, avatar:'https://via.placeholder.com/28' }));
  res.json(members);
});

// API: Add member
app.post('/add-member', async (req,res)=>{
  const { username, user_id, targetGroup, accountId } = req.body;
  const accSnap = await get(ref(db, `accounts/${accountId}`));
  const acc = accSnap.val();
  if(!acc) return res.json({ status:"failed", reason:"Account not found", accountUsed:accountId });

  let client;
  try{ client = await getClient(acc); }catch(e){ return res.json({ status:"failed", reason:e.message, accountUsed:accountId }); }

  let user;
  try{
    user = username ? await client.getEntity(username) : await client.getEntity(user_id);
  }catch{ return res.json({ status:"failed", reason:"User not accessible", accountUsed:accountId }); }

  let status="failed_not_joined", reason="unknown";
  try{
    await client.invoke(new Api.channels.InviteToChannel({ channel: targetGroup, users:[user] }));
    // random delay
    const delay = Math.floor(Math.random()*10000)+8000;
    await new Promise(r=>setTimeout(r,delay));
    // verify
    const participants = await client.getParticipants(targetGroup,{limit:2000});
    if(participants.some(p=>p.id===user.id)){
      status="success"; reason="joined";
    } else {
      status="failed_not_joined"; reason="User did not join";
    }
  }catch(errAdd){
    if(errAdd.message.includes("USER_ALREADY_PARTICIPANT")) { status="failed"; reason="Already member"; }
    else if(errAdd.message.includes("USER_PRIVACY_RESTRICTED")) { status="failed"; reason="User privacy restricted"; }
    else if(errAdd.message.includes("PEER_FLOOD")) { status="failed"; reason="Peer flood limit"; }
    else if(errAdd.message.includes("FLOOD_WAIT")){
      const waitSeconds = Number(errAdd.message.match(/FLOOD_WAIT_(\d+)/)[1]);
      const floodUntil = Date.now()+waitSeconds*1000;
      await update(ref(db,`accounts/${accountId}`),{
        status:"floodwait",
        floodWaitUntil:floodUntil,
        floodWaitDate:new Date(floodUntil).toLocaleString()
      });
      status="failed"; reason=`FloodWait until ${new Date(floodUntil).toLocaleString()}`;
    } else { status="failed"; reason=errAdd.message; }
  }

  await push(ref(db,'history'),{ username, user_id, status, accountUsed:accountId, reason, timestamp:Date.now() });
  res.json({ status, accountUsed:accountId, reason });
});

app.get('/history', async (req,res)=>{
  const snapshot = await get(ref(db,'history'));
  res.json(snapshot.val() || {});
});

app.listen(3000,()=>console.log("Server running on port 3000"));
