import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '@/lib/supabaseClient';

const GUESSABLE = ['Priest', 'Baron', 'Handmaid', 'Prince', 'King', 'Countess', 'Princess'];

// Add a lookup for card values
const CARD_VALUES = {
  Guard: 1,
  Priest: 2,
  Baron: 3,
  Handmaid: 4,
  Prince: 5,
  King: 6,
  Countess: 7,
  Princess: 8,
};

export default function Game() {
  const router = useRouter();
  const { code } = router.query;
  const [state, setState] = useState(null);
  const [chat, setChat] = useState([]);
  const [log, setLog] = useState([]);
  const [pending, setPending] = useState(null);
  const [name, setName] = useState('');
  const [directMessages, setDirectMessages] = useState([]); // <-- NEW
  const [theme, setTheme] = useState('classic'); // <-- NEW
  const pidRef = useRef('');
  const logRef = useRef(null);

  useEffect(() => {
    if (!code) return;
    // Use per-code pid so different games / windows don't share a pid
    const pidKey = `ll_pid_${code}`;
    let pid = localStorage.getItem(pidKey);
    if (!pid) {
      pid = 'p_' + Math.random().toString(36).slice(2, 9);
      localStorage.setItem(pidKey, pid);
    }
    pidRef.current = pid;

    const n = localStorage.getItem(`ll_name_${code}`) || '';
    setName(n);

    // Load theme from localStorage
    const savedTheme = localStorage.getItem('theme') || 'classic';
    setTheme(savedTheme);

    // If user hasn't joined server-side yet, call join to make sure server has our entry
    (async () => {
      try {
        await fetch('/api/game/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'join', code, playerName: n || 'Player', pid }),
        });
      } catch (e) {
        // ignore
      }
    })();

    // initial fetch
    (async () => {
      const { data } = await supabase.from('games').select('*').eq('code', code).maybeSingle();
      if (data) {
        setState(data.state);
        setLog(data.state?.log || []);
        setChat(data.state?.chat || []);
      }
    })();

    // realtime subscribe to this game's row only
    const channel = supabase.channel(`game-${code}`, { config: { broadcast: { self: false } } });
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'games', filter: `code=eq.${code}` },
        (payload) => {
          const s = payload.new?.state || payload.new;
          setState(s);
          setLog(s?.log || []);
          setChat(s?.chat || []);
        }
      )
      .subscribe();

    // --- NEW: subscribe to direct_messages for this game and player ---
    const dmChannel = supabase.channel(`dm-${code}-${pid}`, { config: { broadcast: { self: false } } });
    dmChannel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'direct_messages',
          match: { game_code: code, recipient_id: pid },
        },
        (payload) => {
          setDirectMessages((msgs) => [...msgs, payload.new]);
        }
      )
      .subscribe();

    // Initial fetch for direct messages
    (async () => {
      const { data } = await supabase
        .from('direct_messages')
        .select('*')
        .eq('game_code', code)
        .eq('recipient_id', pid);
      if (data) setDirectMessages(data);
    })();

    channel.on('broadcast', { event: 'directMessagesCleared' }, (payload) => {
      // Re-fetch direct messages for this player
      (async () => {
        const { data } = await supabase
          .from('direct_messages')
          .select('*')
          .eq('game_code', code)
          .eq('recipient_id', pidRef.current);
        setDirectMessages(data || []);
      })();
    });

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(dmChannel);
    };
  }, [code]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  // Toggle theme and save to localStorage
  const toggleTheme = () => {
    const newTheme = theme === 'classic' ? 'taco-bell' : 'classic';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  async function startGame() {
    await fetch('/api/game/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', code, pid: pidRef.current }),
    });
    await fetch('/api/game/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clearDirectMessages', code }),
    });
  }

  async function sendChat(text) {
    if (!text.trim()) return;
    // send pid and name (defensive) so server can attribute correctly
    await fetch('/api/game/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'chat',
        code,
        pid: pidRef.current,
        playerName: localStorage.getItem(`ll_name_${code}`) || 'Unknown',
        message: text,
      }),
    });
  }

  function playCard(idx) {
    const me = state?.players?.find((p) => p.id === pidRef.current);
    if (!me) return alert('No player.');
    const card = me.hand?.[idx];
    if (!card) return;
    const needsTarget = ['Guard', 'Priest', 'Baron', 'Prince', 'King'].includes(card.name);
    if (!needsTarget) {
      return doPlay({ cardIndex: idx });
    }
    setPending({ cardIndex: idx });
  }

  async function doPlay({ cardIndex, targetId, guessedCard }) {
    const r = await fetch('/api/game/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'play', code, cardIndex, targetId, guessedCard, pid: pidRef.current }),
    });
    const data = await r.json();
    if (!data?.ok && data?.message) alert(data.message);
    setPending(null);
  }

  function confirmTarget(targetId) {
    const me = state?.players?.find((p) => p.id === pidRef.current);
    const card = me?.hand?.[pending.cardIndex];
    if (!card) return;
    if (card.name === 'Guard') {
      setPending({ ...pending, targetId }); // Show guess modal
      return;
    }
    doPlay({ cardIndex: pending.cardIndex, targetId });
  }

  const me = state?.players?.find((p) => p.id === pidRef.current) || null;

  return (
    <div className="container">
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <h2>Game: {code}</h2>
        <div className="badge">You: {name || 'Unknown'}</div>
        {/* Theme Switcher */}
        <div>
          <label className="switch">
            <input type="checkbox" checked={theme === 'taco-bell'} onChange={toggleTheme} />
            <span className="slider"></span>
          </label>
          <span style={{ marginLeft: 8 }}>{theme === 'taco-bell' ? 'Taco Bell® Theme' : 'Classic Theme'}</span>
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <div className="card" style={{ flex: 1 }}>
          <h3>Players</h3>
          <div className="list">
            {(state?.players || []).map((p, idx) => (
              <div
                key={p.id}
                style={{
                  padding: '6px 8px',
                  background: p.id === pidRef.current ? '#0f1a2b' : 'transparent',
                  borderRadius: 8,
                }}
              >
                <strong>{p.name}</strong> — Tokens: {p.tokens || 0} {p.protected ? '(protected)' : ''}{' '}
                {p.eliminated ? '(eliminated)' : ''} {state?.currentPlayerIndex === idx ? '← current' : ''}
              </div>
            ))}
          </div>
          <h3 style={{ marginTop: 12 }}>Log</h3>
          <div
            className="log"
            ref={logRef}
            style={{
              maxHeight: 180,
              overflowY: 'auto',
              marginBottom: 8,
              paddingRight: 4,
            }}
          >
            {(log || []).map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={startGame}>
            Start Game
          </button>
          {/* --- NEW: Direct Messages --- */}
          {directMessages.length > 0 && (
            <div className="card" style={{ marginTop: 12, background: '#ffe' }}>
              <h4>Direct Messages</h4>
              <div>
                {directMessages
                  .filter((dm) => dm.recipient_id === pidRef.current)
                  .slice()
                  .reverse()
                  .map((dm) => (
                    <div key={dm.id} style={{ marginBottom: 8 }}>
                      {dm.type === 'privateReveal' && (
                        <span>
                          <strong>Priest Reveal:</strong> {dm.payload.targetName} has{' '}
                          <strong>{dm.payload.card.name}</strong> ({dm.payload.card.value})
                        </span>
                      )}
                      {/* Add more types as needed */}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        <div className="card" style={{ flex: 2 }}>
          <h3>Your Hand</h3>
          <div className="hand">
            {me?.hand?.map((c, i) => (
              <div
                key={i}
                className="cardTile"
                style={{
                  width: 180, // 120px wide
                  height: 270, // 180px tall (2:3 aspect)
                  background: '#f8f8ff',
                  border: '2px solid #ccc',
                  borderRadius: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  margin: '8px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                }}
              >
                <img
                  src={`/cards/${c.name.toLowerCase()}.${theme === 'taco-bell' ? 'svg' : 'jpeg'}`}
                  alt={c.name}
                  style={{
                    width: '144px',
                    height: '216px', // 2:3 aspect
                    objectFit: 'cover',
                    borderRadius: 8,
                    marginTop: 8,
                  }}
                />
                <div style={{ marginTop: 6 }}>
                  <strong>{c.name}</strong> <span className="small">({c.value})</span>
                </div>
                <button className="btn" style={{ marginBottom: 8 }} onClick={() => playCard(i)}>
                  Play
                </button>
              </div>
            )) || <div className="small">Waiting for your hand…</div>}
          </div>
          {pending && pending.targetId && state?.players?.find((p) => p.id === pidRef.current)?.hand?.[pending.cardIndex]?.name ===
            'Guard' && (
            <GuessModal
              onGuess={(g) => doPlay({ cardIndex: pending.cardIndex, targetId: pending.targetId, guessedCard: g })}
              onCancel={() => setPending(null)}
            />
          )}
          {pending && !pending.targetId && (
            <div className="card" style={{ marginTop: 12 }}>
              <h4>Select a target</h4>
              <div className="hand">
                {(state?.players || [])
                  .filter((p) => !p.eliminated && p.id !== pidRef.current)
                  .map((p) => (
                    <button key={p.id} className="btn" onClick={() => confirmTarget(p.id)}>
                      {p.name}
                    </button>
                  ))}
                <button className="btn" onClick={() => confirmTarget(pidRef.current)}>
                  Target Yourself
                </button>
                <button className="btn" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

                    {/* Virtual Table */}
                    <div
                        className="virtual-table"
                        style={{
                            marginTop: 24,
                            padding: '16px 0',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '18px',
                            background: '#f5f5fa',
                            borderRadius: 16,
                            minHeight: 120,
                        }}
                    >
                        {(state?.players || []).map((p, idx) => (
                            <div
                                key={p.id}
                                style={{
                                    display: 'flex',
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    marginBottom: 4,
                                }}
                            >
                                <div
                                    style={{
                                        fontWeight: 'bold',
                                        minWidth: 90,
                                        color: '#000',
                                        marginRight: 12,
                                    }}
                                >
                                    {p.name}
                                    {p.id === pidRef.current ? ' (You)' : ''}
                                </div>
                                <div
                                    style={{
                                        display: 'flex',
                                        gap: '4px',
                                        flexWrap: 'wrap',
                                    }}
                                >
                                    {(p.discarded || []).map((card, ci) => (
                                        <div
                                            key={ci}
                                            style={{
                                                width: 36,
                                                height: 54,
                                                borderRadius: 6,
                                                overflow: 'hidden',
                                                border: '1px solid #bbb',
                                                background: '#fff',
                                                position: 'relative',
                                                boxShadow: '0 1px 4px rgba(0,0,0,0.07)',
                                            }}
                                        >
                                            <img
                                                src={`/cards/${card.name.toLowerCase()}.${theme === 'taco-bell' ? 'svg' : 'jpeg'}`}
                                                alt={card.name}
                                                style={{
                                                    width: '72px',
                                                    height: '108px',
                                                    objectFit: 'cover',
                                                    position: 'absolute',
                                                    left: 0,
                                                    top: 0,
                                                    clipPath: 'inset(0 36px 54px 0)',
                                                }}
                                            />
                                            <div
                                                style={{
                                                    position: 'absolute',
                                                    left: 4,
                                                    top: 4,
                                                    fontSize: 12,
                                                    fontWeight: 'bold',
                                                    color: '#000',
                                                    background: 'rgba(255,255,255,0.85)',
                                                    borderRadius: 2,
                                                    padding: '2px 5px',
                                                }}
                                            >
                                                {card.name[0]}
                                                {card.value}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                        {/* Reveal burn card if game is over and burn exists */}
                        {!state?.started && state?.burn && (
                            <div
                                style={{
                                    marginTop: 12,
                                    display: 'flex',
                                    alignItems: 'center',
                                }}
                            >
                                <div
                                    style={{
                                        fontWeight: 'bold',
                                        minWidth: 90,
                                        color: '#000',
                                        marginRight: 12,
                                    }}
                                >
                                    Burn Card
                                </div>
                                <div
                                    style={{
                                        width: 36,
                                        height: 54,
                                        borderRadius: 6,
                                        overflow: 'hidden',
                                        border: '2px solid #d33',
                                        background: '#fff',
                                        position: 'relative',
                                        boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
                                    }}
                                >
                                    <img
                                        src={`/cards/${state.burn.name.toLowerCase()}.${theme === 'taco-bell' ? 'svg' : 'jpeg'}`}
                                        alt={state.burn.name}
                                        style={{
                                            width: '72px',
                                            height: '108px',
                                            objectFit: 'cover',
                                            position: 'absolute',
                                            left: 0,
                                            top: 0,
                                            clipPath: 'inset(0 36px 54px 0)',
                                        }}
                                    />
                                    <div
                                        style={{
                                            position: 'absolute',
                                            left: 4,
                                            top: 4,
                                            fontSize: 12,
                                            fontWeight: 'bold',
                                            color: '#000',
                                            background: 'rgba(255,230,230,0.95)',
                                            borderRadius: 2,
                                            padding: '2px 5px',
                                        }}
                                    >
                                        {state.burn.name[0]}
                                        {state.burn.value}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="card" style={{ flex: 1 }}>
                    <h3>Chat</h3>
                    <ChatPanel chat={state?.chat || []} onSend={async (t) => sendChat(t)} />
                </div>
            </div>
        </div>
    );
}

function ChatPanel({ chat, onSend }) {
    const [val, setVal] = useState('');
    const chatRef = useRef(null);

    // Auto-scroll to bottom when chat changes
    useEffect(() => {
        if (chatRef.current) {
            chatRef.current.scrollTop = chatRef.current.scrollHeight;
        }
    }, [chat]);

    function handleKeyDown(e) {
        if (e.key === 'Enter' && val.trim()) {
            onSend(val);
            setVal('');
        }
    }

    return (
        <div>
            <div
                className="chat"
                ref={chatRef}
                style={{
                    maxHeight: 180,
                    overflowY: 'auto',
                    marginBottom: 8,
                    paddingRight: 4,
                }}
            >
                {(chat || []).map((c, i) => (
                    <div key={i}>
                        <strong>{c.sender || c.name || 'Unknown'}:</strong> {c.message}
                    </div>
                ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
                <input
                    className="input"
                    value={val}
                    onChange={(e) => setVal(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Say hi…"
                />
                <button
                    className="btn"
                    onClick={() => {
                        if (val.trim()) {
                            onSend(val);
                            setVal('');
                        }
                    }}
                >
                    Send
                </button>
            </div>
        </div>
    );
}

// Update GuessModal to show name and value in dropdown
function GuessModal({ onGuess, onCancel }) {
    const [guess, setGuess] = useState(GUESSABLE[0]);
    return (
        <div className="card" style={{ marginTop: 12 }}>
            <h4>Guess a card</h4>
            <select
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                style={{ marginBottom: 8, width: '100%' }}
            >
                {GUESSABLE.map((g) => (
                    <option key={g} value={g}>
                        {g} ({CARD_VALUES[g]})
                    </option>
                ))}
            </select>
            <div>
                <button className="btn primary" onClick={() => onGuess(guess)}>
                    Guess
                </button>
                <button className="btn" style={{ marginLeft: 8 }} onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </div>
    );
}