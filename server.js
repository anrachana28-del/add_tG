import 'dotenv/config'
import express from 'express'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, update, get, push } from 'firebase/database'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { WebSocketServer } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'

const app = express()
app.use(express.json())

/* =========================
   FIREBASE
========================= */

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}

initializeApp(firebaseConfig)
const db = getDatabase()

/* =========================
   LOAD TELEGRAM ACCOUNTS
========================= */

const accounts = []

let i = 1
while (process.env[`TG_ACCOUNT_${i}_PHONE`]) {

  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]

  accounts.push({
    id:`TG_ACCOUNT_${i}`,
    phone,
    api_id,
    api_hash,
    session,
    status:"pending",
    floodWaitUntil:null
  })

  i++
}

/* =========================
   TELEGRAM CLIENT
========================= */

async function createClient(acc){

  const client = new TelegramClient(
    new StringSession(acc.session),
    acc.api_id,
    acc.api_hash,
    { connectionRetries:5 }
  )

  await client.start({})
  return client
}

/* =========================
   ACCOUNT HEALTH CHECK
========================= */

async function checkAccount(acc){

  let client

  try{

    client = await createClient(acc)

    await client.getMe()

    acc.status="active"

    await update(ref(db,`accounts/${acc.id}`),{
      phone:acc.phone,
      status:"active",
      lastChecked:Date.now()
    })

    sendLog("info",`${acc.phone} active`)

  }catch(err){

    acc.status="error"

    await update(ref(db,`accounts/${acc.id}`),{
      status:"error",
      error:err.message,
      lastChecked:Date.now()
    })

    sendLog("error",`${acc.phone} error ${err.message}`)

  }finally{

    if(client) await client.disconnect()

  }

}

/* =========================
   AUTO CHECK
========================= */

async function autoCheck(){

  for(const acc of accounts){

    await checkAccount(acc)

    await new Promise(r=>setTimeout(r,3000))

  }

}

setInterval(autoCheck,60000)

autoCheck()

/* =========================
   MEMBER SCRAPER
========================= */

app.post('/members', async(req,res)=>{

  try{

    const { group } = req.body

    const acc = accounts[0]

    const client = await createClient(acc)

    const entity = await client.getEntity(group)

    const participants = await client.getParticipants(entity,{
      limit:2000
    })

    const members = participants.map(p=>({

      user_id:p.id,
      username:p.username,
      bot:p.bot || false,
      avatar:`https://t.me/i/userpic/320/${p.id}.jpg`

    }))

    await client.disconnect()

    sendLog("info",`scraped ${members.length} members from ${group}`)

    res.json(members)

  }catch(err){

    sendLog("error",err.message)

    res.status(500).json({error:err.message})

  }

})

/* =========================
   AUTO JOIN GROUP
========================= */

app.post('/join-group', async(req,res)=>{

  try{

    const { group } = req.body

    const acc = accounts[0]

    const client = await createClient(acc)

    await client.invoke(

      new Api.channels.JoinChannel({
        channel:group
      })

    )

    await client.disconnect()

    sendLog("success",`${acc.phone} joined ${group}`)

    res.json({success:true})

  }catch(err){

    sendLog("error",err.message)

    res.json({success:false})

  }

})

/* =========================
   ACCOUNT STATUS API
========================= */

app.get('/account-status', async(req,res)=>{

  const snap = await get(ref(db,'accounts'))

  res.json(snap.val() || {})

})

/* =========================
   HISTORY
========================= */

app.get('/history', async(req,res)=>{

  const snap = await get(ref(db,'history'))

  res.json(snap.val() || {})

})

/* =========================
   EXPORT JSON
========================= */

app.get('/export', async(req,res)=>{

  const snap = await get(ref(db,'history'))

  const data = snap.val() || {}

  res.setHeader("Content-Disposition","attachment; filename=history.json")

  res.send(JSON.stringify(data,null,2))

})

/* =========================
   SERVE DASHBOARD
========================= */

const __filename = fileURLToPath(import.meta.url)

const __dirname = path.dirname(__filename)

app.get('/',(req,res)=>{

  res.sendFile(path.join(__dirname,'index.html'))

})

/* =========================
   WEBSOCKET LOGS
========================= */

const server = app.listen(process.env.PORT || 3000, ()=>{

  console.log("🚀 Server started")

})

const wss = new WebSocketServer({ server })

function sendLog(type,message){

  const data = JSON.stringify({
    type,
    message,
    time:new Date().toLocaleTimeString()
  })

  wss.clients.forEach(client=>{

    if(client.readyState === 1){

      client.send(data)

    }

  })

}
