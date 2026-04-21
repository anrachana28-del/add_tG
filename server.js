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

// ================= UTIL =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ================= FIREBASE =================
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}

initializeApp(firebaseConfig)
const db = getDatabase()

// ================= DATA =================
const accounts = []
const clientCache = {}
let isChecking = false

// ================= NORMALIZE =================
function normalizeUsername(input){
  if(!input) return null
  let u = input.trim()
  if(u.includes("t.me/")) u = u.split("/").pop()
  return u.replace("@","").trim()
}

function normalizeGroup(group){
  if(!group) return group
  let g = group.trim()
  if(g.includes("t.me/")) g = g.split("/").pop()
  return g
}

// ================= SAVE ACCOUNT =================
async function saveAccountToFirebase(account){
  try{
    const snap = await get(ref(db,'accounts'))
    const data = snap.val() || {}

    const exists = Object.values(data).some(a => a.phone === account.phone)
    if(exists) return false

    await update(ref(db,`accounts/${account.id}`),{
      phone:account.phone,
      api_id:account.api_id,
      api_hash:account.api_hash,
      session:account.session,
      status:"active",
      floodWaitUntil:null,
      addCount:0,
      createdAt:Date.now()
    })

    return true
  }catch(e){
    console.log(e.message)
    return false
  }
}

// ================= LOAD ACCOUNTS =================
let i=1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id=Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash=process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session=process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone=process.env[`TG_ACCOUNT_${i}_PHONE`]

  if(!api_id||!api_hash||!session){i++; continue}

  const account={
    phone, api_id, api_hash, session,
    id:`TG_ACCOUNT_${i}`,
    status:"active",
    floodWaitUntil:null,
    addCount:0
  }

  accounts.push(account)
  saveAccountToFirebase(account)
  i++
}

// ================= TELEGRAM CLIENT =================
async function getClient(account){

  if(clientCache[account.id]){
    try{
      await clientCache[account.id].getMe()
      return clientCache[account.id]
    }catch{
      delete clientCache[account.id]
    }
  }

  const client = new TelegramClient(
    new StringSession(account.session),
    account.api_id,
    account.api_hash,
    { connectionRetries: 3 }
  )

  await client.connect()
  await client.getMe()

  clientCache[account.id] = client
  return client
}

// ================= FLOOD PARSER =================
function parseFlood(err){
  const msg = err.message || ""
  const m = msg.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

// ================= REFRESH =================
async function refreshAccountStatus(account){
  const now = Date.now()

  if(account.floodWaitUntil && account.floodWaitUntil < now){
    account.floodWaitUntil = null

    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      floodWaitUntil:null
    })
  }
}

// ================= CHECK ACCOUNT =================
async function checkTGAccount(account){
  try{
    await refreshAccountStatus(account)

    const client = await getClient(account)
    await client.getMe()

    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      lastChecked:Date.now()
    })

  }catch(err){
    const wait = parseFlood(err)
    let status="error"
    let until=null

    if(wait){
      status="floodwait"
      until = Date.now() + wait*1000
      account.floodWaitUntil = until
    }

    await update(ref(db,`accounts/${account.id}`),{
      status,
      floodWaitUntil:until,
      error:err.message,
      lastChecked:Date.now()
    })
  }
}

// ================= AUTO CHECK (SAFE) =================
let index = 0

async function autoCheck(){
  if(isChecking) return
  isChecking = true

  try{
    if(!accounts.length) return

    const acc = accounts[index % accounts.length]
    index++

    if(acc && acc.status !== "error"){
      await checkTGAccount(acc)
    }

    await sleep(5000)

  }finally{
    isChecking = false
  }
}

setInterval(autoCheck, 15 * 60 * 1000)

// ================= AVAILABLE ACCOUNT =================
let accIndex = 0

function getAvailableAccount(){
  const now = Date.now()

  for(let i=0;i<accounts.length;i++){
    let idx = (accIndex + i) % accounts.length
    let acc = accounts[idx]

    if(
      acc.status === "active" &&
      (!acc.floodWaitUntil || acc.floodWaitUntil < now)
    ){
      accIndex = idx + 1
      return acc
    }
  }
  return null
}

// ================= AUTO JOIN =================
async function autoJoin(client, group){
  const clean = normalizeGroup(group)

  try{
    await client.getEntity(clean)
  }catch{
    try{
      await client.invoke(new Api.messages.ImportChatInvite({hash:clean}))
    }catch{}
  }
}

// ================= AUTO JOIN ALL =================
async function autoJoinAllAccounts(group){
  for(const acc of accounts){
    try{
      const client = await getClient(acc)
      await autoJoin(client, group)
      await sleep(1000)
    }catch{}
  }
}

// ================= FIXED ROUTE (IMPORTANT) =================
app.post('/auto-join', async (req,res)=>{
  try{
    const { group, account } = req.body

    const acc = accounts.find(a=>a.id===account)
    if(!acc) return res.json({error:"not found"})

    const client = await getClient(acc)
    await autoJoin(client, group)

    res.json({status:"success"})
  }catch(err){
    res.json({status:"failed",error:err.message})
  }
})

// ================= MEMBERS =================
let lastCall = 0

app.post('/members', async (req,res)=>{
  try{
    if(Date.now()-lastCall < 5000){
      return res.json({error:"rate limit"})
    }
    lastCall = Date.now()

    let {group,offset=0,limit=50}=req.body

    const acc = getAvailableAccount()
    if(!acc) return res.json({error:"no account"})

    const client = await getClient(acc)
    const cleanGroup = normalizeGroup(group)

    await autoJoin(client,cleanGroup)

    const entity = await client.getEntity(cleanGroup)

    const participants = await client.getParticipants(entity,{
      offset,limit
    })

    res.json({
      members:participants.map(p=>({
        user_id:p.id,
        username:p.username,
        access_hash:p.access_hash
      })),
      nextOffset:offset+participants.length
    })

  }catch(err){
    res.json({error:err.message})
  }
})

// ================= ADD MEMBER =================
app.post('/add-member', async(req,res)=>{
  try{
    let {username,user_id,access_hash,targetGroup}=req.body

    const acc = getAvailableAccount()
    if(!acc) return res.json({status:"failed"})

    const client = await getClient(acc)
    await autoJoin(client,targetGroup)

    const cleanUsername = normalizeUsername(username)

    let userEntity

    if(cleanUsername){
      userEntity = await client.getEntity(cleanUsername)
    }else{
      userEntity = new Api.InputUser({
        userId:user_id,
        accessHash:BigInt(access_hash)
      })
    }

    const group = await client.getEntity(targetGroup)

    await client.invoke(new Api.channels.InviteToChannel({
      channel:group,
      users:[userEntity]
    }))

    await sleep(5000)

    res.json({status:"success"})

  }catch(err){
    res.json({status:"failed",reason:err.message})
  }
})

// ================= STATUS =================
app.get('/account-status', async(req,res)=>{
  const snap = await get(ref(db,'accounts'))
  res.json(snap.val()||{})
})

app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'))
  res.json(snap.val()||{})
})

// ================= FRONTEND =================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.static(__dirname))
app.get('/',(req,res)=>
  res.sendFile(path.join(__dirname,'index.html'))
)

// ================= START =================
const PORT = process.env.PORT || 3000
app.listen(PORT,()=>console.log("🚀 RUNNING"))
