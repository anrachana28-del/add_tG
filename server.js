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

    const group = await client.getEntity(targetGroup);
   let user;

try{
  user = username
    ? await client.getEntity(username)
    : await client.getEntity(user_id);
}catch{
  return res.json({
    status:"failed",
    accountUsed:acc.id,
    reason:"User not accessible"
  });
}

    let status = "failed_not_joined", reason="unknown";

    try{
      await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [user] }));
      // Delay 5 seconds
        const delay = Math.floor(Math.random()*10000)+8000;
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
