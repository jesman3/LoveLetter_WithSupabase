import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '@/lib/supabaseClient';

const GUESSABLE = ['Priest','Baron','Handmaid','Prince','King','Countess','Princess'];

export default function Game(){
  const router = useRouter();
  const { code } = router.query;
  const [state, setState] = useState(null);
  const [chat, setChat] = useState([]);
  const [log, setLog] = useState([]);
  const [pending, setPending] = useState(null);
  const [name, setName] = useState('');
  const [directMessages, setDirectMessages] = useState([]); // <-- NEW
  const pidRef = useRef('');

  useEffect(()=>{
    if(!code) return;
    // Use per-code pid so different games / windows don't share a pid
    const pidKey = `ll_pid_${code}`;
    let pid = localStorage.getItem(pidKey);
    if(!pid){
      pid = 'p_'+Math.random().toString(36).slice(2,9);
      localStorage.setItem(pidKey, pid);
    }
    pidRef.current = pid;

    const n = localStorage.getItem(`ll_name_${code}`) || '';
    setName(n);

    // If user hasn't joined server-side yet, call join to make sure server has our entry
    (async ()=>{
      try{
        await fetch('/api/game/action', {
          method:'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ action:'join', code, playerName: n || 'Player', pid })
        });
      }catch(e){
        // ignore
      }
    })();

    // initial fetch
    (async ()=>{
      const { data } = await supabase.from('games').select('*').eq('code', code).maybeSingle();
      if(data) { setState(data.state); setLog(data.state?.log || []); setChat(data.state?.chat || []); }
    })();

    // realtime subscribe to this game's row only
    const channel = supabase.channel(`game-${code}`, { config: { broadcast: { self: false } }});
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `code=eq.${code}` }, (payload)=>{
      const s = payload.new?.state || payload.new;
      setState(s); setLog(s?.log || []); setChat(s?.chat || []);
    }).subscribe();

    // --- NEW: subscribe to direct_messages for this game and player ---
    const dmChannel = supabase.channel(`dm-${code}-${pid}`, { config: { broadcast: { self: false } } });
    dmChannel.on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'direct_messages',
        match: { game_code: code, recipient_id: pid } // <-- FIXED
    }, (payload) => {
        setDirectMessages(msgs => [...msgs, payload.new]);
    }).subscribe();

    // initial fetch for direct messages
    (async ()=>{
      const { data } = await supabase
        .from('direct_messages')
        .select('*')
        .eq('game_code', code)
        .eq('recipient_id', pid);
      if(data) setDirectMessages(data);
    })();

    return ()=>{
      supabase.removeChannel(channel);
      supabase.removeChannel(dmChannel);
    };
  }, [code]);

  async function startGame(){
    await fetch('/api/game/action', { 
      method:'POST', 
      headers:{'Content-Type':'application/json'}, 
      body: JSON.stringify({ action:'start', code, pid: pidRef.current }) // Pass pid
    });
  }

  async function sendChat(text){
    if(!text.trim()) return;
    // send pid and name (defensive) so server can attribute correctly
    await fetch('/api/game/action', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'chat', code, pid: pidRef.current, playerName: localStorage.getItem(`ll_name_${code}`) || 'Unknown', message: text })
    });
  }

  function playCard(idx){
    const me = state?.players?.find(p=>p.id===pidRef.current);
    if(!me) return alert('No player.');
    const card = me.hand?.[idx];
    if(!card) return;
    const needsTarget = ['Guard','Priest','Baron','Prince','King'].includes(card.name);
    if(!needsTarget){ return doPlay({ cardIndex: idx }); }
    setPending({ cardIndex: idx });
  }

  async function doPlay({ cardIndex, targetId, guessedCard }){
    const r = await fetch('/api/game/action', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'play', code, cardIndex, targetId, guessedCard, pid: pidRef.current })
    });
    const data = await r.json();
    if(!data?.ok && data?.message) alert(data.message);
    setPending(null);
  }

  function confirmTarget(targetId){
    const me = state?.players?.find(p=>p.id===pidRef.current);
    const card = me?.hand?.[pending.cardIndex];
    if(!card) return;
    if(card.name==='Guard'){
      const g = prompt('Guess a card (not Guard): '+GUESSABLE.join(', '));
      if(!g) return;
      const guess = g.trim();
      if(!GUESSABLE.includes(guess)) return alert('Invalid guess');
      return doPlay({ cardIndex: pending.cardIndex, targetId, guessedCard: guess });
    }
    doPlay({ cardIndex: pending.cardIndex, targetId });
  }

  const me = state?.players?.find(p=>p.id===pidRef.current) || null;

  return (
    <div className="container">
      <div className="row" style={{alignItems:'center', justifyContent:'space-between'}}>
        <h2>Game: {code}</h2>
        <div className="badge">You: {name||'Unknown'}</div>
      </div>

      <div className="row" style={{marginTop:12}}>
        <div className="card" style={{flex:1}}>
          <h3>Players</h3>
          <div className="list">
            {(state?.players||[]).map((p,idx)=>(
              <div key={p.id} style={{padding:'6px 8px', background:p.id===pidRef.current?'#0f1a2b':'transparent', borderRadius:8}}>
                <strong>{p.name}</strong> — Tokens: {p.tokens||0} {p.protected?'(protected)':''} {p.eliminated?'(eliminated)':''} {state?.currentPlayerIndex===idx?'← current':''}
              </div>
            ))}
          </div>
          <h3 style={{marginTop:12}}>Log</h3>
          <div className="log">{(log||[]).slice().reverse().map((l,i)=>(<div key={i}>{l}</div>))}</div>
          <button className="btn primary" style={{marginTop:12}} onClick={startGame}>Start Game</button>
          {/* --- NEW: Direct Messages --- */}
          {directMessages.length > 0 && (
            <div className="card" style={{marginTop:12, background:'#ffe'}}>
              <h4>Direct Messages</h4>
              <div>
                {directMessages.slice().reverse().map(dm => (
                  <div key={dm.id} style={{marginBottom:8}}>
                    {dm.type === 'privateReveal' && (
                      <span>
                        <strong>Priest Reveal:</strong> {dm.payload.targetName} has <strong>{dm.payload.card.name}</strong> ({dm.payload.card.value})
                      </span>
                    )}
                    {/* Add more types as needed */}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="card" style={{flex:2}}>
          <h3>Your Hand</h3>
          <div className="hand">
            {me?.hand?.map((c,i)=>(
              <div
                key={i}
                className="cardTile"
                style={{
                  width: 180,           // 120px wide
                  height: 270,          // 180px tall (2:3 aspect)
                  background: '#f8f8ff',
                  border: '2px solid #ccc',
                  borderRadius: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  margin: '8px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
                }}
              >
                <img
                  src={`/cards/${c.name.toLowerCase()}.jpeg`}
                  alt={c.name}
                  style={{
                    width: '144px',
                    height: '216px',    // 2:3 aspect
                    objectFit: 'cover',
                    borderRadius: 8,
                    marginTop: 8
                  }}
                />
                <div style={{marginTop:6}}>
                  <strong>{c.name}</strong> <span className="small">({c.value})</span>
                </div>
                <button className="btn" style={{marginBottom:8}} onClick={()=>playCard(i)}>Play</button>
              </div>
            )) || <div className="small">Waiting for your hand…</div>}
          </div>
          {pending && (
            <div className="card" style={{marginTop:12}}>
              <h4>Select a target</h4>
              <div className="hand">
                {(state?.players||[]).filter(p=>!p.eliminated && p.id!==pidRef.current).map(p=>
                  <button key={p.id} className="btn" onClick={()=>confirmTarget(p.id)}>{p.name}</button>
                )}
                <button className="btn" onClick={()=>confirmTarget(pidRef.current)}>Target Yourself</button>
                <button className="btn" onClick={()=>setPending(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        <div className="card" style={{flex:1}}>
          <h3>Chat</h3>
          <ChatPanel chat={state?.chat || []} onSend={async (t)=>sendChat(t)} />
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ chat, onSend }){
  const [val,setVal] = useState('');
  return (
    <div>
      <div className="chat">
        {(chat||[]).map((c,i)=>(<div key={i}><strong>{c.sender || c.name || 'Unknown'}:</strong> {c.message}</div>))}
      </div>
      <div className="row" style={{marginTop:8}}>
        <input className="input" value={val} onChange={e=>setVal(e.target.value)} placeholder="Say hi…" />
        <button className="btn" onClick={()=>{ if(val.trim()){ onSend(val); setVal(''); } }}>Send</button>
      </div>
    </div>
  );
}
