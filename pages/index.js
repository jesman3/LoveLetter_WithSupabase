import { useState } from 'react';

export default function Lobby(){
  const [name,setName] = useState('');
  const [code,setCode] = useState('');
  const [creating,setCreating] = useState(false);

  // helper: local per-game pid key (use when navigating to a specific code)
  function makePid() {
    return 'p_' + Math.random().toString(36).slice(2,9);
  }

  async function createGame(){
    if(!name.trim()) return alert('Enter your name');
    setCreating(true);

    // generate a pid for the creator (temporary until server returns final)
    const pid = makePid();
    // NOTE: we don't set a global/localStorage pid key here because we don't know the code yet.
    // We'll set the per-code pid when the server returns the code + pid.
    const res = await fetch('/api/game/action', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ action:'create', playerName: name, pid })
    });
    const data = await res.json();
    setCreating(false);
    if(!data?.code){
      return alert('Create failed');
    }

    // persist pid keyed by code so other games don't collide
    localStorage.setItem(`ll_pid_${data.code}`, data.pid || pid);
    localStorage.setItem(`ll_name_${data.code}`, name);
    // navigate to game
    window.location.href = `/game/${data.code}`;
  }

  async function joinGame(){
    if(!name.trim()) return alert('Enter your name');
    if(!code.trim()) return alert('Enter a game code');

    const pid = localStorage.getItem(`ll_pid_${code.trim().toUpperCase()}`) || ('p_'+Math.random().toString(36).slice(2,9));
    // store before join so the client can identify itself immediately
    localStorage.setItem(`ll_pid_${code.trim().toUpperCase()}`, pid);
    localStorage.setItem(`ll_name_${code.trim().toUpperCase()}`, name);

    const res = await fetch('/api/game/action', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'join', code: code.trim().toUpperCase(), playerName:name, pid })
    });
    const data = await res.json();
    if(!data?.ok){
      return alert('Join failed — invalid code or game already started.');
    }
    // server may return a canonical pid; store it if present
    if(data.pid) localStorage.setItem(`ll_pid_${code.trim().toUpperCase()}`, data.pid);

    window.location.href = `/game/${code.trim().toUpperCase()}`;
  }

  return (
    <div className="container">
      <div className="card">
        <h1>Love Letter — Lobby</h1>
        <p className="small">Create a room or join by code. State is synced via Supabase Realtime.</p>
        <div className="row" style={{marginTop:12, alignItems:'center'}}>
          <input className="input" placeholder="Your name" value={name} onChange={e=>setName(e.target.value)} />
          <button className="btn primary" onClick={createGame} disabled={creating}>{creating ? 'Creating…' : 'Create Game'}</button>
        </div>
        <div className="row" style={{marginTop:12, alignItems:'center'}}>
          <input className="input" placeholder="Game code (e.g., ABCD)" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} />
          <button className="btn" onClick={joinGame}>Join</button>
        </div>
      </div>
      <footer style={{marginTop:16}} className="small">Deploy to Vercel. You’ll need Supabase keys — see README.</footer>
    </div>
  );
}
