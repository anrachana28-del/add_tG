import 'dotenv/config'
import express from 'express'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, update, get, push } from 'firebase/database'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import path from 'path'
import { fileURLToPath } from 'url'

const app = express()
app.use(express.json())

/* ================= FIREBASE ================= */

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}

initializeApp(firebaseConfig)
const db = getDatabase()

/* ================= ACCOUNTS ================= */

const accounts = []
let i = 1

while (process.env[`TG_ACCOUNT_${i}_PHONE`]) {

  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]

  accounts.push({
    id: `TG_ACCOUNT_${i}`,
    phone,
    api_id,
    api_hash,
    session,
    status: "pending",
    floodWaitUntil: null
  })

  i++
}

/* ================= ACCOUNT CHECK ================= */

async function checkTGAccount(account){

let client

try{

client = new TelegramClient(
new StringSession(account.session),
account.api_id,
account.api_hash,
{connectionRetries:5}
)

await client.start()
await client.getMe()

account.status="active"

await update(ref(db,`accounts/${account.id}`),{
status:"active",
phone:account.phone,
lastChecked:Date.now(),
floodWaitUntil:null
})

}catch(err){

let status="error"
let floodUntil=null

if(err.message.includes("FLOOD_WAIT")){

const m = err.message.match(/FLOOD_WAIT_(\d+)/)

if(m){

const sec = Number(m[1])

floodUntil = Date.now()+sec*1000

status="floodwait"

account.floodWaitUntil=floodUntil

}

}

await update(ref(db,`accounts/${account.id}`),{
status,
phone:account.phone,
error:err.message,
lastChecked:Date.now(),
floodWaitUntil:floodUntil
})

}finally{

if(client) await client.disconnect()

}

}

/* ================= AUTO CHECK ================= */

async function autoCheck(){

for(const acc of accounts){

await checkTGAccount(acc)

await new Promise(r=>setTimeout(r,2000))

}

}

setInterval(autoCheck,60000)
autoCheck()

/* ================= ACCOUNT STATUS ================= */

app.get('/account-status',async(req,res)=>{

const snap = await get(ref(db,'accounts'))
const data = snap.val() || {}
const now = Date.now()

for(const id in data){

const acc = data[id]

if(acc.floodWaitUntil && acc.floodWaitUntil>now){

const remain = acc.floodWaitUntil-now
acc.floodWaitCountdown = remain

const d = new Date(acc.floodWaitUntil)

acc.floodWaitTimeStr = d.toLocaleTimeString('en-US',{hour12:true})

}

}

res.json(data)

})

/* ================= ADD MEMBER ================= */

let accountIndex = 0

app.post('/add-member', async(req,res)=>{

try{

const { username, user_id, targetGroup, accountId } = req.body
const now = Date.now()

/* ---------- ACTIVE ACCOUNTS ---------- */

const activeAccounts = accounts.filter(
a=>!a.floodWaitUntil || a.floodWaitUntil<now
)

if(activeAccounts.length===0){

const nextReady = accounts.map(a=>a.floodWaitUntil||0).sort()[0]
const waitDate = new Date(nextReady)

return res.json({
status:"all_floodwait",
reason:`All accounts FloodWait until ${waitDate.toLocaleTimeString('en-US',{hour12:true})}`
})

}

/* ---------- SELECT ACCOUNT ---------- */

let acc

if(accountId){

acc = accounts.find(a=>a.id===accountId)

}else{

acc = activeAccounts[accountIndex % activeAccounts.length]
accountIndex++

}

/* ---------- CLIENT ---------- */

const client = new TelegramClient(
new StringSession(acc.session),
acc.api_id,
acc.api_hash,
{connectionRetries:5}
)

await client.start()

const group = await client.getEntity(targetGroup)
const user = username
? await client.getEntity(username)
: await client.getEntity(user_id)

let status="failed"
let reason="unknown"

/* ---------- INVITE ---------- */

try{

await client.invoke(
new Api.channels.InviteToChannel({
channel:group,
users:[user]
})
)

/* ---------- VERIFY ---------- */

let joined=false

try{

await client.invoke(
new Api.channels.GetParticipant({
channel:group,
participant:user
})
)

joined=true

}catch(e){

joined=false

}

if(joined){

status="success"
reason="User joined"

/* DELAY ONLY SUCCESS */

const delay = Math.floor(Math.random()*30000)+30000
await new Promise(r=>setTimeout(r,delay))

}else{

status="failed"
reason="User not joined"

}

}catch(errAdd){

if(errAdd.message.includes("USER_ALREADY_PARTICIPANT")){

status="already"
reason="Member already in group"

}

else if(errAdd.message.includes("USER_PRIVACY_RESTRICTED")){

status="failed"
reason="User privacy restricted"

}

else if(errAdd.message.includes("PEER_FLOOD")){

status="failed"
reason="Peer flood limit"

}

else if(errAdd.message.includes("FLOOD_WAIT")){

const m = errAdd.message.match(/FLOOD_WAIT_(\d+)/)

if(m){

const sec = Number(m[1])
const floodUntil = Date.now()+sec*1000

acc.floodWaitUntil=floodUntil
acc.status="floodwait"

await update(ref(db,`accounts/${acc.id}`),{
status:"floodwait",
floodWaitUntil:floodUntil
})

const floodDate = new Date(floodUntil)

status="failed"
reason=`FloodWait until ${floodDate.toLocaleTimeString('en-US',{hour12:true})}`

}

}

else{

status="failed"
reason=errAdd.message

}

}

/* ---------- SAVE HISTORY ---------- */

await push(ref(db,'history'),{
username,
user_id,
status,
accountUsed:acc.id,
reason,
timestamp:Date.now()
})

await client.disconnect()

res.json({
status,
accountUsed:acc.id,
reason
})

}catch(err){

res.status(500).json({error:err.message})

}

})

/* ================= FETCH MEMBERS ================= */

app.post('/members', async(req,res)=>{

try{

const { group } = req.body
const now = Date.now()

const acc = accounts.find(a=>!a.floodWaitUntil || a.floodWaitUntil<now)

if(!acc){

return res.status(500).json({error:"All accounts FloodWait"})

}

const client = new TelegramClient(
new StringSession(acc.session),
acc.api_id,
acc.api_hash,
{connectionRetries:5}
)

await client.start()

const entity = await client.getEntity(group)

const participants = await client.getParticipants(entity,{limit:2000})

const members = participants
.filter(p=>!p.bot && !p.deleted)
.map(p=>({
user_id:p.id,
username:p.username,
avatar:`https://t.me/i/userpic/320/${p.id}.jpg`
}))

await client.disconnect()

res.json(members)

}catch(err){

res.status(500).json({error:err.message})

}

})

/* ================= HISTORY ================= */

app.get('/history', async(req,res)=>{

const snap = await get(ref(db,'history'))
res.json(snap.val() || {})

})

/* ================= FRONTEND ================= */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.get('/',(req,res)=>{
res.sendFile(path.join(__dirname,'index.html'))
})

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000

app.listen(PORT,()=>{
console.log("Server running on port",PORT)
})
