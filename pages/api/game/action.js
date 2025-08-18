import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function createDeck(){
  const cards=[];
  for(let i=0;i<5;i++) cards.push({name:'Guard', value:1});
  for(let i=0;i<2;i++) cards.push({name:'Priest', value:2});
  for(let i=0;i<2;i++) cards.push({name:'Baron', value:3});
  for(let i=0;i<2;i++) cards.push({name:'Handmaid', value:4});
  for(let i=0;i<2;i++) cards.push({name:'Prince', value:5});
  cards.push({name:'King', value:6});
  cards.push({name:'Countess', value:7});
  cards.push({name:'Princess', value:8});
  return shuffle(cards);
}
function shuffle(arr){ return arr.slice().sort(()=>Math.random()-0.5); }

async function upsertGame(code, state){
  const { error } = await supabase.from('games').upsert({ code, state }, { onConflict: 'code' });
  if(error) throw error;
}
async function getGame(code){
  const { data, error } = await supabase.from('games').select('*').eq('code', code).maybeSingle();
  if(error) throw error;
  return data;
}

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ error:'Only POST' });
  const body = req.body || {};
  const { action } = body;
  try{
    if(action === 'create'){
      const playerName = body.playerName || 'Player';
      const code = Math.random().toString(36).substring(2,6).toUpperCase();
      const pid = body.pid || ('p_'+Math.random().toString(36).slice(2,9));
      const state = {
        code,
        players: [{ id: pid, name: playerName, hand: [], tokens: 0, eliminated: false }],
        deck: [],
        started: false,
        currentPlayerIndex: 0,
        log: [],
        chat: [],
        burn: null
      };
      await upsertGame(code, state);
      return res.status(200).json({ code, pid });
    }

    if(action === 'join'){
      const { code, playerName, pid } = body;
      const row = await getGame(code);
      if(!row) return res.status(404).json({ ok:false, message:'game not found' });
      const state = row.state;
      if(state.started) return res.status(400).json({ ok:false, message:'already started' });
      const canonicalPid = pid || ('p_'+Math.random().toString(36).slice(2,9));
      const exists = state.players.find(p => p.id === canonicalPid || p.name === playerName);
      if(!exists){
        state.players.push({ id: canonicalPid, name: playerName, hand: [], tokens: 0, eliminated: false });
      }
      await upsertGame(code, state);
      return res.status(200).json({ ok:true, pid: canonicalPid });
    }

    if(action === 'start'){
      const { code, pid } = body; // Accept pid
      const row = await getGame(code);
      if(!row) return res.status(404).json({ ok:false, message:'game not found' });
      const state = row.state;
      if(state.started) return res.status(400).json({ ok:false, message:'already started' });
      state.started = true;
      state.deck = createDeck();
      state.burn = state.deck.pop();
      state.players.forEach(p => { p.hand = [ state.deck.pop() ]; p.eliminated = false; p.protected = false; });
      // Find the index of the player who started the game
      const starterIdx = state.players.findIndex(p => p.id === pid);
      state.currentPlayerIndex = starterIdx >= 0 ? starterIdx : 0;
      state.log = [];
      if(state.deck.length>0) state.players[state.currentPlayerIndex].hand.push(state.deck.pop());
      await upsertGame(code, state);
      return res.status(200).json({ ok:true });
    }

    if(action === 'chat'){
      const { code, message, pid, playerName } = body;
      const row = await getGame(code);
      if(!row) return res.status(404).json({ ok:false, message:'game not found' });
      const state = row.state;
      // prefer pid to find sender; fallback to provided playerName; fallback to 'Unknown'
      let senderName = 'Unknown';
      if(pid){
        const p = state.players.find(x=>x.id===pid);
        if(p) senderName = p.name;
      }
      if(senderName === 'Unknown' && playerName) senderName = playerName;
      const entry = { sender: senderName, message, ts: Date.now() };
      state.chat = state.chat || [];
      state.chat.push(entry);
      await upsertGame(code, state);
      return res.status(200).json({ ok:true });
    }

    if(action === 'play'){
      const { code, cardIndex, targetId, guessedCard, pid } = body;
      const row = await getGame(code);
      if(!row) return res.status(404).json({ ok:false, message:'game not found' });
      const state = row.state;
      const playerIndex = state.players.findIndex(p=>p.id===pid);
      if(playerIndex === -1) return res.status(400).json({ ok:false, message:'player not found' });
      if(playerIndex !== state.currentPlayerIndex) return res.status(400).json({ ok:false, message:'not your turn' });

      const player = state.players[playerIndex];
      if(player.eliminated) return res.status(400).json({ ok:false, message:'eliminated' });
      if(cardIndex < 0 || cardIndex >= player.hand.length) return res.status(400).json({ ok:false, message:'invalid card index' });

      // Enforce Countess rule BEFORE removing played card
      const candidate = player.hand[cardIndex];
      const other = player.hand.find((_,i)=>i!==cardIndex);
      if(other && other.name === 'Countess' && (candidate.name === 'King' || candidate.name === 'Prince')){
        return res.status(400).json({ ok:false, message:'Countess rule: must discard Countess if holding with King/Prince' });
      }

      // Remove the played card
      const card = player.hand.splice(cardIndex,1)[0];

      state.log = state.log || [];
      state.log.push(`${player.name} played ${card.name}.`);

      // target validations
      if(targetId){
        const t = state.players.find(p=>p.id===targetId);
        if(!t) return res.status(400).json({ ok:false, message:'target not found' });
        if(t.protected) return res.status(400).json({ ok:false, message:'target protected by Handmaid' });
      }

      switch(card.name){
        case 'Guard':{
          if(!targetId) return res.status(400).json({ ok:false, message:'Guard needs a target' });
          if(!guessedCard || guessedCard==='Guard') return res.status(400).json({ ok:false, message:'Invalid guess' });
          const tgt = state.players.find(p=>p.id===targetId);
          if(!tgt?.hand?.length) return res.status(400).json({ ok:false, message:'Target has no card' });
          const actual = tgt.hand[0].name;
          if(actual === guessedCard){
            tgt.eliminated = true;
            state.log.push(`${player.name} guessed ${guessedCard} correctly — ${tgt.name} is eliminated.`);
          } else {
            state.log.push(`${player.name} guessed ${guessedCard} — wrong.`);
          }
          break;
        }
        case 'Priest':{
          if(!targetId) return res.status(400).json({ ok:false, message:'Priest needs a target' });
          const tgt = state.players.find(p=>p.id===targetId);
          if(!tgt?.hand?.length) return res.status(400).json({ ok:false, message:'Target has no card' });
          state.log.push(`${player.name} used Priest on ${tgt.name}.`);
          break;
        }
        case 'Baron':{
          if(!targetId) return res.status(400).json({ ok:false, message:'Baron needs a target' });
          const tgt = state.players.find(p=>p.id===targetId);
          const myCard = player.hand[0];
          const theirCard = tgt?.hand?.[0];
          if(!myCard || !theirCard) return res.status(400).json({ ok:false, message:'Both must have a card' });
          if(myCard.value > theirCard.value){ tgt.eliminated = true; state.log.push(`${player.name} (${myCard.name}) beat ${tgt.name} (${theirCard.name}).`); }
          else if(myCard.value < theirCard.value){ player.eliminated = true; state.log.push(`${tgt.name} (${theirCard.name}) beat ${player.name} (${myCard.name}).`); }
          else { state.log.push(`${player.name} and ${tgt.name} tied with ${myCard.name}.`); }
          break;
        }
        case 'Handmaid':{
          player.protected = true; state.log.push(`${player.name} is protected until their next turn.`);
          break;
        }
        case 'Prince':{
          if(!targetId) return res.status(400).json({ ok:false, message:'Prince needs a target' });
          const tgt = state.players.find(p=>p.id===targetId);
          const discarded = tgt?.hand?.pop();
          if(!discarded) return res.status(400).json({ ok:false, message:'Target has no card' });
          state.log.push(`${tgt.name} discarded ${discarded.name} due to Prince.`);
          if(discarded.name==='Princess'){ tgt.eliminated = true; state.log.push(`${tgt.name} discarded the Princess and was eliminated.`); }
          else { if(state.deck.length>0) tgt.hand = [ state.deck.pop() ]; else tgt.hand = []; }
          break;
        }
        case 'King':{
          if(!targetId) return res.status(400).json({ ok:false, message:'King needs a target' });
          const tgt = state.players.find(p=>p.id===targetId);
          if(!tgt?.hand?.length || !player.hand?.length) return res.status(400).json({ ok:false, message:'Both need a card to swap' });
          const tmp = player.hand[0]; player.hand[0] = tgt.hand[0]; tgt.hand[0] = tmp;
          state.log.push(`${player.name} swapped hands with ${tgt.name}.`);
          break;
        }
        case 'Countess':{
          state.log.push(`${player.name} discarded the Countess.`);
          break;
        }
        case 'Princess':{
          player.eliminated = true; state.log.push(`${player.name} discarded the Princess and was eliminated.`);
          break;
        }
      }

      // Round end checks
      const active = state.players.filter(p=>!p.eliminated);
      const newRound = ()=>{
        state.deck = createDeck();
        state.burn = state.deck.pop();
        state.players.forEach(p=>{ p.hand=[state.deck.pop()]; p.eliminated=false; p.protected=false; });
        state.currentPlayerIndex = 0;
        if(state.deck.length>0) state.players[0].hand.push(state.deck.pop());
      };

      if(active.length <= 1){
        const winner = active[0];
        if(winner) winner.tokens = (winner.tokens||0) + 1;
        state.log.push(`${winner ? winner.name : 'No one'} won the round (last player standing).`);
        newRound();
        await upsertGame(code, state);
        return res.status(200).json({ ok:true });
      }

      if(state.deck.length === 0){
        const living = state.players.filter(p=>!p.eliminated && p.hand?.length>0);
        if(living.length>0){
          living.sort((a,b)=>b.hand[0].value - a.hand[0].value);
          living[0].tokens = (living[0].tokens||0) + 1;
          state.log.push(`${living[0].name} won the round (highest card when deck empty).`);
        }
        newRound();
        await upsertGame(code, state);
        return res.status(200).json({ ok:true });
      }

      // Next turn
      do {
        state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
      } while(state.players[state.currentPlayerIndex].eliminated);
      if(state.players[state.currentPlayerIndex].protected) delete state.players[state.currentPlayerIndex].protected;
      if(state.deck.length>0) state.players[state.currentPlayerIndex].hand.push(state.deck.pop());

      await upsertGame(code, state);
      return res.status(200).json({ ok:true });
    }

    return res.status(400).json({ ok:false, message:'unknown action' });
  }catch(err){
    console.error('action error', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
}
