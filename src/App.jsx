import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from './state.jsx'
import * as I from './icons.jsx'

const PRESETS = ['🌌','🪐','🦊','🐼','🐱','🐺','🦄','🌙','⚡','🎮','🎧','🍇']
const EMOJIS = ['😀','😂','😍','😎','😭','😡','👍','👎','❤️','🔥','🎉','💜','✅','🤔','😴','🥳','😇','😈','💀','🙈','👏','🙏','✨','🚀']
const QUICK_REACTIONS = ['👍','❤️','😂','🔥','😭','😍','👌','💩']
const REACTION_EMOJIS = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😍','🥰','😘','😎','🤩','🥳','😢','😭','😡','🤬','😱','😴','🤔','🙄','😮','😏','🤗','🫡','👍','👎','👏','🙏','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','🔥','✨','🎉','✅','❌','💯','🚀','💩','☠️','🤡','👀','🥹','💔','❤️‍🔥','👌']
const STATUS_LABELS = { auto: 'Автоматически', online: 'В сети', away: 'Отошёл', dnd: 'Не беспокоить', offline: 'Не в сети' }
const GAME_META = {
  racing: { label: 'Nexly Racing', icon: '🏎️', description: 'Лёгкие мини-гонки 1 на 1' },
  tictactoe: { label: 'Крестики-нолики', icon: '❌⭕', description: 'Классическая игра 3×3' },
  rps: { label: 'Камень-ножницы-бумага', icon: '✊✌️✋', description: 'Быстрый матч' }
}
const GAME_TRACKS = ['Ночной город', 'Неоновая трасса', 'Космодром']
const CALL_RING_TIMEOUT_MS = 60000
const cls = (...a) => a.filter(Boolean).join(' ')
const fmt = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fallbackAvatar = (name) => `https://ui-avatars.com/api/?background=7c3aed&color=fff&name=${encodeURIComponent(name || 'N')}`
const presetAvatar = (emoji) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop stop-color='#9b5cff'/><stop offset='1' stop-color='#3b1a74'/></linearGradient></defs><rect width='256' height='256' rx='128' fill='url(#g)'/><text x='50%' y='55%' text-anchor='middle' dominant-baseline='middle' font-size='120'>${emoji}</text></svg>`)
const statusText = (status) => STATUS_LABELS[status] || STATUS_LABELS.offline

async function isBlockedBetween(userA, userB) {
  if (!userA || !userB || userA === userB) return false
  const { data, error } = await supabase
    .from('blocked_users')
    .select('blocker_id,blocked_id')
    .or(`and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`)
    .limit(1)
  if (error) {
    console.warn('Block lookup failed:', error.message)
    return false
  }
  return Boolean(data?.length)
}

async function loadFriendProfiles(userId) {
  if (!userId) return []

  // Prefer the server-side friends RPC. It is SECURITY DEFINER and therefore
  // does not depend on the client's current friendships RLS visibility.
  try {
    const { data, error } = await supabase.rpc('get_my_friends')
    if (!error && Array.isArray(data)) {
      return data.filter(u => u && u.id && u.id !== userId)
    }
  } catch {}

  const ids = new Set()

  // Fallback for older databases without get_my_friends().
  const [outgoing, incoming, sentAccepted, receivedAccepted] = await Promise.all([
    supabase.from('friendships').select('friend_id').eq('user_id', userId),
    supabase.from('friendships').select('user_id').eq('friend_id', userId),
    supabase.from('friend_requests').select('receiver_id').eq('sender_id', userId).eq('status', 'accepted'),
    supabase.from('friend_requests').select('sender_id').eq('receiver_id', userId).eq('status', 'accepted')
  ])

  for (const row of outgoing.data || []) if (row.friend_id && row.friend_id !== userId) ids.add(row.friend_id)
  for (const row of incoming.data || []) if (row.user_id && row.user_id !== userId) ids.add(row.user_id)
  for (const row of sentAccepted.data || []) if (row.receiver_id && row.receiver_id !== userId) ids.add(row.receiver_id)
  for (const row of receivedAccepted.data || []) if (row.sender_id && row.sender_id !== userId) ids.add(row.sender_id)

  if (!ids.size) return []

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id,username,display_name,avatar_url,phone,status,status_mode,bio')
    .in('id', [...ids])
    .order('display_name')

  if (error) {
    console.warn('Failed to load friend profiles:', error.message)
    return []
  }

  return (profiles || []).filter(Boolean)
}
const groupAvatar = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><rect width='256' height='256' rx='128' fill='#7c3aed'/><circle cx='102' cy='98' r='34' fill='white'/><circle cx='162' cy='104' r='29' fill='white' opacity='.88'/><path d='M48 190c8-36 29-55 54-55s47 19 54 55' fill='white'/><path d='M126 190c7-31 25-48 46-48 21 0 37 17 43 48' fill='white' opacity='.88'/></svg>`) 

function mediaSupported() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
}

function recorderMime(kind) {
  const list = kind === 'video'
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return list.find((m) => MediaRecorder.isTypeSupported?.(m)) || ''
}

function browserMediaError(e) {
  if (!window.isSecureContext) return 'Камера и микрофон доступны только по HTTPS или на localhost.'
  if (!navigator.mediaDevices?.getUserMedia) return 'Браузер не поддерживает доступ к камере/микрофону.'
  if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') return 'Доступ к камере/микрофону запрещён. Нажми на значок 🔒 возле адреса сайта и разреши доступ.'
  if (e?.name === 'NotFoundError') return 'Камера или микрофон не найдены на устройстве.'
  if (e?.name === 'NotReadableError') return 'Камера или микрофон заняты другой программой.'
  if (e?.name === 'OverconstrainedError') return 'Устройство не поддерживает выбранный режим камеры.'
  return `Не удалось получить доступ к устройству: ${e?.message || 'неизвестная ошибка'}`
}

export default function App() {
  const { loading } = useAuth()
  if (loading) return <div className="boot"><div className="brand-mark">N</div><div>Nexly</div><span className="spinner" /></div>
  return <MainRouter />
}

function MainRouter() {
  const { session, profile } = useAuth()
  if (!session) return <Auth />
  if (!profile) return <div className="boot"><div className="spinner" />Загрузка профиля…</div>
  return <Messenger />
}

function Auth() {
  const { register, login, error, setError } = useAuth()
  const [mode, setMode] = useState('login')
  const [id, setId] = useState('')
  const [pass, setPass] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') await login({ username: id, password: pass })
      else await register({ username: id, password: pass, displayName: name, phone })
    } catch (err) {
      setError(err.message || 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  return <div className="auth-shell"><div className="auth-glow" /><form className="auth-card" onSubmit={submit}>
    <div className="brand-lockup"><div className="logo-box">N</div><div><div className="brand-title">Nexly</div><div className="muted">личный мессенджер</div></div></div>
    <div className="auth-tabs">
      <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError('') }}>Войти</button>
      <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError('') }}>Создать аккаунт</button>
    </div>
    {mode === 'register' && <input value={name} onChange={e => setName(e.target.value)} placeholder="Отображаемое имя" />}
    <input value={id} onChange={e => setId(e.target.value)} placeholder="Имя пользователя" autoCapitalize="none" autoComplete="username" required minLength={3} />
    {mode === 'register' && <input value={phone} onChange={e => setPhone(e.target.value.replace(/[^0-9+()\-\s]/g, ''))} placeholder="Номер телефона — необязательно" />}
    <input value={pass} onChange={e => setPass(e.target.value)} placeholder="Пароль" type="password" required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
    <button className="primary big" disabled={busy}>{busy ? <><span className="spinner small" />Загрузка…</> : mode === 'login' ? 'Войти' : 'Создать'}</button>
    {error && <div className="error-box">{error}</div>}
  </form></div>
}

function Messenger() {
  const { profile, session, logout, refreshProfile } = useAuth()
  const [theme, setTheme] = useState(() => localStorage.getItem('nexly-theme') || 'dark')
  const [notifications, setNotifications] = useState(() => localStorage.getItem('nexly-notifications') !== 'off')
  const [view, setView] = useState('chats')
  const [mobileNav, setMobileNav] = useState(false)
  const [selected, setSelected] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [call, setCall] = useState(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [gameInvite, setGameInvite] = useState(null)
  const [game, setGame] = useState(null)
  const seenIncomingCalls = useRef(new Set())

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('nexly-theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('nexly-notifications', notifications ? 'on' : 'off') }, [notifications])

  useEffect(() => {
    if (!profile?.id) return
    const mode = profile.status_mode || 'auto'
    const sync = async () => {
      const status = mode === 'auto' ? 'online' : mode
      await supabase.from('profiles').update({ status, last_seen:new Date().toISOString(), updated_at:new Date().toISOString() }).eq('id', profile.id)
    }
    sync()
    const timer=setInterval(sync,25000)
    const hide=()=>{ if(mode==='auto') supabase.from('profiles').update({status:'offline',last_seen:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',profile.id) }
    window.addEventListener('pagehide',hide)
    return ()=>{clearInterval(timer);window.removeEventListener('pagehide',hide)}
  },[profile?.id,profile?.status_mode])

  const openIncomingCall = async (callId) => {
    if (!callId || seenIncomingCalls.current.has(callId)) return
    seenIncomingCalls.current.add(callId)
    try {
      const { data: cs, error: ce } = await supabase
        .from('call_sessions')
        .select('id,conversation_id,caller_id,kind,status,expires_at')
        .eq('id', callId)
        .maybeSingle()
      if (ce || !cs || cs.caller_id === session.user.id || !['ringing','active'].includes(cs.status)) {
        seenIncomingCalls.current.delete(callId)
        return
      }
      if (cs.expires_at && new Date(cs.expires_at).getTime() <= Date.now()) {
        seenIncomingCalls.current.delete(callId)
        return
      }
      if (await isBlockedBetween(session.user.id, cs.caller_id)) {
        seenIncomingCalls.current.delete(callId)
        return
      }

      const [{ data: caller }, { data: conversation }] = await Promise.all([
        supabase.from('profiles').select('id,username,display_name,avatar_url,phone,bio,status,status_mode').eq('id', cs.caller_id).maybeSingle(),
        supabase.from('conversations').select('id,type,title,description,avatar_url').eq('id', cs.conversation_id).maybeSingle()
      ])
      if (!caller) {
        seenIncomingCalls.current.delete(callId)
        return
      }
      // Group calls are rooms, not incoming calls. Members join manually
      // from the group-call message/header.
      if (conversation?.type === 'group') {
        seenIncomingCalls.current.delete(callId)
        return
      } else {
        if (caller.status === 'dnd') {
          await supabase.rpc('reject_call', { p_call_id: callId })
          seenIncomingCalls.current.delete(callId)
          return
        }
        setCall({
          target: { type: 'direct', other: caller },
          video: cs.kind === 'video',
          incoming: true,
          callerId: cs.caller_id,
          callId
        })
        if (notifications) notifyIncoming('Nexly — входящий звонок', `${caller.display_name || caller.username} звонит вам`)
      }
    } catch (e) {
      seenIncomingCalls.current.delete(callId)
      console.warn('Incoming call lookup failed:', e?.message || e)
    }
  }

  useEffect(() => {
    let active = true
    const channels = []
    const setup = async () => {
      const db = supabase
        .channel(`calls-db-inbox-${session.user.id}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'call_participants',
          filter: `user_id=eq.${session.user.id}`
        }, ({ new: row, eventType }) => {
          if (!active || !row || row.user_id !== session.user.id) return
          if ((eventType === 'INSERT' || eventType === 'UPDATE') && row.status === 'invited') openIncomingCall(row.call_id)
        })
        .subscribe()
      channels.push(db)

      // Compatibility fallback for clients that still send an inbox broadcast.
      const inbox = supabase.channel(`calls-inbox-${session.user.id}`)
        .on('broadcast', { event: 'invite' }, async ({ payload }) => {
          if (!active || !payload || payload.to !== session.user.id) return
          if (payload.call_id) {
            await openIncomingCall(payload.call_id)
          }
        })
        .subscribe()
      channels.push(inbox)

      // Group calls do not ring every member. The only persistent notification is
      // the group-call message; a member joins it manually.
    }
    setup()
    return () => {
      active = false
      channels.forEach(c => supabase.removeChannel(c))
    }
  }, [session.user.id, notifications, refresh])

  useEffect(()=>{
    let active=true
    const ch=supabase.channel(`games-inbox-${session.user.id}`)
      .on('broadcast',{event:'invite'},async({payload})=>{
        if(!active||!payload||payload.to!==session.user.id)return
        if(await isBlockedBetween(session.user.id, payload.from))return
        const {data:sender}=await supabase.from('profiles').select('id,username,display_name,avatar_url,status').eq('id',payload.from).maybeSingle(); if(!sender)return
        setGameInvite({...payload,sender}); if(notifications){playPing();notifyIncoming('Nexly — приглашение в игру',`${sender.display_name||sender.username} приглашает вас в ${GAME_META[payload.game]?.label||'игру'}`)}
      })
      .on('broadcast',{event:'response'},async({payload})=>{
        if(!active||!payload||payload.to!==session.user.id)return
        const {data:opponent}=await supabase.from('profiles').select('id,username,display_name,avatar_url,status').eq('id',payload.from).maybeSingle(); if(!opponent)return
        if(payload.status==='accepted') setGame({inviteId:payload.invite_id,game:payload.game,opponent,incoming:false})
        else if(payload.status==='rejected' && notifications) notifyIncoming('Nexly — игра отклонена',`${opponent.display_name||opponent.username} отклонил приглашение` )
      }).subscribe()
    return ()=>{active=false;supabase.removeChannel(ch)}
  },[session.user.id,notifications])

  const broadcastCallInvite = async (userId, callId, kind, groupId = null) => {
    if (!userId || !callId) return
    const inbox = supabase.channel(`calls-inbox-${userId}`)
    await new Promise(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      inbox.subscribe(status => {
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish()
      })
    })
    try {
      if (inbox.state === 'joined') {
        await inbox.send({
          type: 'broadcast',
          event: 'invite',
          payload: {
            to: userId,
            from: session.user.id,
            call_id: callId,
            kind,
            group_id: groupId
          }
        })
      }
    } finally {
      setTimeout(() => supabase.removeChannel(inbox), 5000)
    }
  }

  const startCall = async (targetObj, video = false) => {
    if (!targetObj) return
    if (targetObj.type !== 'group' && !targetObj.other?.id) return

    if (targetObj.type === 'group') {
      const { data: members, error: membersError } = await supabase
        .from('conversation_members')
        .select('user_id,profiles(id,username,display_name,avatar_url)')
        .eq('conversation_id', targetObj.id)
        .eq('banned', false)

      if (membersError) return alert(membersError.message)

      const activeMembers = (members || []).filter(x => x.profiles)
      if (activeMembers.length > 6) {
        return alert('В групповом звонке может быть максимум 6 участников.')
      }

      // GROUP CALL = ROOM.
      // There is deliberately no broadcast/incoming ringing to every member.
      // Starting the call opens the room for the initiator. Everyone else can
      // join later from the group-call message or the phone/video button.
      const { data: existingCall, error: existingError } = await supabase
        .from('call_sessions')
        .select('id,caller_id,kind,status,expires_at,created_at')
        .eq('conversation_id', targetObj.id)
        .in('status', ['ringing', 'active'])
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (existingError) return alert(existingError.message)

      if (existingCall) {
        const { error: joinError } = await supabase.rpc('answer_call', {
          p_call_id: existingCall.id
        })
        if (joinError) {
          return alert('Не удалось присоединиться к звонку: ' + joinError.message)
        }

        const { data: connectedRows } = await supabase
          .from('call_participants')
          .select('user_id,status,profiles(id,username,display_name,avatar_url)')
          .eq('call_id', existingCall.id)
          .eq('status', 'connected')

        setCall({
          isGroup: true,
          group: targetObj,
          groupId: targetObj.id,
          video: existingCall.kind === 'video',
          incoming: false,
          autoJoin: true,
          callerId: existingCall.caller_id,
          callId: existingCall.id,
          allowed: (connectedRows || []).map(x => x.profiles).filter(Boolean)
        })
        setInfoOpen(false)
        return
      }

      const { data: callId, error: callError } = await supabase.rpc('start_call', {
        p_conversation_id: targetObj.id,
        p_kind: video ? 'video' : 'audio'
      })
      if (callError) return alert(callError.message)

      setCall({
        isGroup: true,
        group: targetObj,
        groupId: targetObj.id,
        video,
        incoming: false,
        callerId: session.user.id,
        callId,
        allowed: [{
          id: session.user.id,
          username: profile?.username || session.user.user_metadata?.username || '',
          display_name: profile?.display_name || session.user.user_metadata?.display_name || '',
          avatar_url: profile?.avatar_url || session.user.user_metadata?.avatar_url || ''
        }]
      })
      setInfoOpen(false)
      return
    }

    const targetId = targetObj.other.id
    if (await isBlockedBetween(session.user.id, targetId)) return alert('Звонки между вами недоступны.')

    const { data: callId, error: callError } = await supabase
      .rpc('start_call', { p_conversation_id: targetObj.id, p_kind: video ? 'video' : 'audio' })
    if (callError) return alert(callError.message)

    const ch = supabase.channel(`call-${callId}`)
    await new Promise(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      ch.subscribe(status => { if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish() })
    })

    setCall({ target: targetObj, video, incoming: false, callerId: session.user.id, callId, inviteChannel: ch })
    setInfoOpen(false)

    // Direct broadcast makes incoming ringing instant even if Postgres Changes is delayed.
    await broadcastCallInvite(targetId, callId, video ? 'video' : 'audio')
  }

  return <div className="shell"><Topbar onMenu={()=>setMobileNav(true)} onHome={()=>{setView('chats');setInfoOpen(false);setMobileNav(false)}} profile={profile} theme={theme} setTheme={setTheme} notifications={notifications} setNotifications={setNotifications} logout={logout}/><div className="workspace"><IconRail view={view} setView={id=>{setView(id);if(id==='chats')setInfoOpen(false)}} profile={profile}/><Sidebar view={view} setView={setView} selected={selected} setSelected={item=>{setSelected(item);setInfoOpen(false);if(item)setView('chats')}} session={session} refresh={refresh} setRefresh={setRefresh} onClose={()=>setMobileNav(false)} mobile={mobileNav} notificationsEnabled={notifications}/><ChatPanel selected={selected} profile={profile} session={session} setInfoOpen={setInfoOpen} refresh={refresh} setRefresh={setRefresh} onCall={startCall} notificationsEnabled={notifications}/><InfoPanel open={infoOpen} selected={selected} session={session} onCall={startCall} onClose={()=>setInfoOpen(false)}/>{view==='settings'&&<div className="settings-overlay"><Settings setRefresh={setRefresh} onBack={()=>setView('chats')}/></div>}</div>{mobileNav&&<div className="scrim mobile-only" onClick={()=>setMobileNav(false)}/>} {call&&<CallModal call={call} session={session} onClose={()=>setCall(null)}/>} {gameInvite&&<GameInviteModal invite={gameInvite} session={session} onClose={()=>setGameInvite(null)} onAccept={payload=>{setGameInvite(null);setGame(payload)}}/>}{game&&<GameModal game={game} session={session} onClose={()=>setGame(null)}/>}</div>
}

function Topbar({ onMenu, onHome, profile, theme, setTheme, notifications, setNotifications, logout }) {
  const [open, setOpen] = useState(false)
  const toggleNotifications = async () => {
    if (!notifications && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission()
    setNotifications(v => !v)
    setOpen(false)
  }
  return <header className="topbar">
    <button className="icon-btn mobile-only" title="Меню" onClick={onMenu}><I.Menu /></button>
    <button type="button" className="top-brand top-brand-button" title="Главное меню" onClick={onHome}><div className="logo-box tiny">N</div><b>Nexly</b></button>
    <div className="top-actions">
      <button className="icon-btn" title="Тема" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <I.Sun /> : <I.Moon />}</button>
      <div style={{ position: 'relative' }}>
        <button className={cls('icon-btn', notifications && 'active')} title="Уведомления" onClick={() => setOpen(v => !v)}><I.Bell /></button>
        {open && <div className="context-menu" style={{ right: 0, top: 44, left: 'auto', width: 250 }}>
          <button onClick={toggleNotifications}><I.Bell />{notifications ? 'Выключить уведомления' : 'Включить уведомления'}</button>
          <button onClick={() => { setNotifications(true); setOpen(false) }}>Включены для Nexly</button>
          <button onClick={() => { setNotifications(false); setOpen(false) }}>Выключить</button>
        </div>}
      </div>
      <div className="profile-pill"><img src={profile.avatar_url || fallbackAvatar(profile.display_name || profile.username)} /><span>{profile.display_name || profile.username}<small>@{profile.username}</small></span></div>
      <button className="icon-btn" title="Выйти" onClick={() => { if (confirm('Выйти из Nexly?')) logout() }}><I.LogOut /></button>
    </div>
  </header>
}

function IconRail({ view, setView, profile }) {
  const items = [['chats', 'Чаты', I.MessageCircle], ['groups', 'Группы', I.Users], ['settings', 'Настройки', I.Settings]]
  return <aside className="icon-rail">{items.map(([id, label, C]) => <button key={id} className={cls('rail-btn', view === id && 'active')} title={label} onClick={() => setView(id)}><C /></button>)}<div className="rail-spacer" /><div className="rail-avatar"><img src={profile.avatar_url || fallbackAvatar(profile.username)} /></div></aside>
}

function Sidebar({ view, setView, selected, setSelected, session, refresh, setRefresh, onClose, mobile, notificationsEnabled }) {
  const [search,setSearch]=useState(''),[rows,setRows]=useState([]),[friends,setFriends]=useState([]),[requests,setRequests]=useState([]),[groups,setGroups]=useState([]),[showNewGroup,setShowNewGroup]=useState(false)
  const load=async()=>{
    const [membersRes,friendProfiles,rqRes]=await Promise.all([
      supabase.from('conversation_members').select('conversation_id,role,unread_count,conversations(id,type,title,description,avatar_url,owner_id)').eq('user_id',session.user.id).eq('banned',false),
      loadFriendProfiles(session.user.id),
      supabase.from('friend_requests').select('id,sender_id,status,profiles!friend_requests_sender_id_fkey(id,username,display_name,avatar_url,phone,status,bio)').eq('receiver_id',session.user.id).eq('status','pending')
    ])
    const members=membersRes.data||[], ids=members.map(x=>x.conversation_id); let all=[]
    if(ids.length){
      const r=await supabase.from('conversation_members').select('conversation_id,user_id,profiles(id,username,display_name,avatar_url,phone,status,bio)').in('conversation_id',ids)
      all=r.data||[]
    }
    const out=members.map(m=>{
      const conv=m.conversations
      if(!conv)return null
      if(conv.type==='group')return {...conv,type:'group',unread_count:m.unread_count||0,avatar_url:conv.avatar_url||groupAvatar,other:{display_name:conv.title,username:conv.title,avatar_url:conv.avatar_url||groupAvatar,id:conv.owner_id}}
      const other=all.find(x=>x.conversation_id===m.conversation_id&&x.user_id!==session.user.id)?.profiles
      return {...conv,type:'direct',other,unread_count:m.unread_count||0}
    }).filter(c=>c?.other?.id||c.type==='group')
    setFriends(friendProfiles || [])
    const existingFriendIds=new Set(out.filter(c=>c.type==='direct').map(c=>c.other?.id))
    const friendRows=friendProfiles.filter(f=>!existingFriendIds.has(f.id)).map(f=>({id:`friend-${f.id}`,type:'direct',friendOnly:true,other:f}))
    const combined=[...out.filter(c=>c.type==='group'),...out.filter(c=>c.type==='direct'),...friendRows]
    setRows(combined)
    setGroups(combined.filter(x=>x.type==='group'))
    setRequests(rqRes.data||[])
  }
  useEffect(()=>{load()},[refresh,session.user.id])
  useEffect(()=>{const ch=supabase.channel('sidebar-'+session.user.id).on('postgres_changes',{event:'*',schema:'public',table:'friend_requests',filter:`receiver_id=eq.${session.user.id}`},async()=>{if(notificationsEnabled)playPing();await load()}).on('postgres_changes',{event:'*',schema:'public',table:'friendships'},load).on('postgres_changes',{event:'*',schema:'public',table:'conversation_members'},load).subscribe();return()=>supabase.removeChannel(ch)},[session.user.id,notificationsEnabled])
  const accept=async r=>{if(await isBlockedBetween(session.user.id, r.sender_id))return alert('Взаимодействие с этим пользователем заблокировано.');const {error:e1}=await supabase.from('friend_requests').update({status:'accepted',updated_at:new Date().toISOString()}).eq('id',r.id);if(e1)return alert(e1.message);const {error:e2}=await supabase.from('friendships').upsert([{user_id:session.user.id,friend_id:r.sender_id},{user_id:r.sender_id,friend_id:session.user.id}]);if(e2)return alert(e2.message);const {data:cid,error:e3}=await supabase.rpc('create_direct_conversation',{target_user_id:r.sender_id});if(e3)return alert(e3.message);setRefresh(v=>v+1);setSelected({id:cid,type:'direct',other:r.profiles});onClose()}
  const reject=async r=>{const {error}=await supabase.from('friend_requests').update({status:'rejected',updated_at:new Date().toISOString()}).eq('id',r.id);if(error)alert(error.message);setRefresh(v=>v+1)}
  const sendRequest=async u=>{if(await isBlockedBetween(session.user.id, u.id))return alert('Пользователь заблокирован.');const {error}=await supabase.from('friend_requests').insert({sender_id:session.user.id,receiver_id:u.id,status:'pending'});if(error)alert(error.message);else setSearch('')}
  const selectConv=async c=>{if(c.friendOnly&&c.other?.id){const {data,error}=await supabase.rpc('create_direct_conversation',{target_user_id:c.other.id});if(error)return alert(error.message);c={id:data,type:'direct',other:c.other}}setSelected(c);setView('chats');onClose()}
  return <aside className={cls('sidebar',mobile&&'mobile-open')}><div className="sidebar-head"><div><div className="section-title">{view==='chats'?'Чаты':view==='groups'?'Группы':'Настройки'}</div><div className="section-sub">Nexly</div></div><button className="icon-btn mobile-only" onClick={onClose}><I.X/></button></div>{view==='chats'&&<div className="search-box"><I.Search/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск по ID…"/></div>}{view==='chats'&&search&&<SearchResults q={search} session={session} onRequest={sendRequest}/>}<div className="sidebar-scroll">{view==='chats'&&<><SectionLabel icon={<I.UserPlus/>}>Заявки ({requests.length})</SectionLabel>{requests.length>0&&requests.map(r=><div className="request-row" key={r.id}><img src={r.profiles.avatar_url||fallbackAvatar(r.profiles.display_name||r.profiles.username)}/><div className="grow"><b>{r.profiles.display_name||r.profiles.username}</b><small>@{r.profiles.username}</small></div><div className="request-actions"><button className="mini-btn ok" onClick={()=>accept(r)}><I.Check/></button><button className="mini-btn no" onClick={()=>reject(r)}><I.X/></button></div></div>)}<SectionLabel icon={<I.MessageCircle/>}>Друзья и чаты</SectionLabel>{rows.filter(c=>c.type==='direct').map(c=><ConversationRow key={c.id} c={c} selected={selected?.id===c.id} onClick={()=>selectConv(c)}/>)}{!rows.some(c=>c.type==='direct')&&<EmptySide text="Пока нет чатов. Найди друга по ID выше."/>}<SectionLabel icon={<I.Users/>}>Группы</SectionLabel>{groups.map(g=><ConversationRow key={g.id} c={g} selected={selected?.id===g.id} onClick={()=>selectConv(g)}/>)}<button className="outline full" onClick={()=>setShowNewGroup(true)}><I.Plus/>Создать группу</button></>}{view==='groups'&&<GroupList groups={groups} onNew={()=>setShowNewGroup(true)} onSelect={selectConv}/>} {view==='settings'&&<div className="muted">Настройки открыты поверх чата.</div>}</div>{showNewGroup&&<NewGroupModal session={session} contacts={friends.map(f=>({type:'direct',other:f}))} onClose={()=>setShowNewGroup(false)} onDone={group=>{setShowNewGroup(false);setRefresh(v=>v+1);setSelected(group);setView('groups');onClose()}}/>}</aside>
}

function SearchResults({ q, session, onRequest }) {
  const [data, setData] = useState([])
  useEffect(() => {
    let active = true
    const clean = q.replace(/[%_]/g, '')
    supabase.from('profiles').select('id,username,display_name,avatar_url,status').ilike('username', `%${clean}%`).neq('id', session.user.id).limit(20).then(({ data }) => active && setData(data || []))
    return () => { active = false }
  }, [q, session.user.id])
  return <div className="search-results">
    {data.map(u => <div className="search-result" key={u.id}><img src={u.avatar_url || fallbackAvatar(u.display_name || u.username)} /><div className="grow"><b>{u.display_name || u.username}</b><small>@{u.username} · {statusText(u.status)}</small></div><button className="mini-btn" onClick={() => onRequest(u)} title="Добавить в друзья"><I.UserPlus /></button></div>)}
    {!data.length && <EmptySide text="Ничего не найдено" />}
  </div>
}

function SectionLabel({ icon, children }) { return <div className="section-label">{icon}{children}</div> }
function EmptySide({ text }) { return <div className="empty-side">{text}</div> }
function ConversationRow({ c, selected, onClick }) {
  const name = c.type === 'group' ? (c.title || 'Группа') : (c.other?.display_name || (c.other?.username ? `@${c.other.username}` : 'Пользователь'))
  const img = c.type === 'group' ? (c.avatar_url || groupAvatar) : c.other?.avatar_url
  const sub = c.type === 'group' ? 'Группа' : statusText(c.other?.status)
  return <button className={cls('conv-row', selected && 'selected')} onClick={onClick}><img src={img || fallbackAvatar(name)} /><span className="grow"><b>{name}</b><small className={c.other?.status === 'online' ? 'online' : ''}>{sub}</small></span>{c.unread_count>0&&<span className="unread-badge">{c.unread_count>99?'99+':c.unread_count}</span>}<I.MoreHorizontal /></button>
}
function GroupList({ groups, onNew, onSelect }) {
  return <div><SectionLabel icon={<I.Users />}>Группы</SectionLabel>{groups.map(g => <button key={g.id} className="row" onClick={() => onSelect(g)}><img src={g.avatar_url || groupAvatar} style={{ width: 42, height: 42, borderRadius: '50%' }} /><div className="grow"><b>{g.title}</b><small>{g.description || 'Группа Nexly'}</small></div></button>)}{!groups.length && <EmptySide text="Пока нет групп" />}<button className="outline full" onClick={onNew}><I.Plus />Создать группу</button></div>
}

function Settings({ profile, setRefresh, onBack }) {
  const { profile:authProfile, refreshProfile, session } = useAuth(); const p=profile||authProfile
  const [saving,setSaving]=useState(false),[name,setName]=useState(p?.display_name||''),[phone,setPhone]=useState(p?.phone||''),[bio,setBio]=useState(p?.bio||''),[statusMode,setStatusMode]=useState(p?.status_mode||'auto'),[blocked,setBlocked]=useState([]),[note,setNote]=useState('')
  useEffect(()=>{setName(p?.display_name||'');setPhone(p?.phone||'');setBio(p?.bio||'');setStatusMode(p?.status_mode||'auto')},[p?.id,p?.display_name,p?.phone,p?.bio,p?.status_mode])
  const loadBlocked=async()=>{const {data}=await supabase.from('blocked_users').select('blocked_id,profiles(id,username,display_name,avatar_url)').eq('blocker_id',session.user.id);setBlocked(data||[])}
  useEffect(()=>{loadBlocked()},[session.user.id])
  const save=async()=>{const clean=phone.trim().replace(/[()\-\s]/g,'');if(clean&&!/^\+[1-9]\d{6,14}$/.test(clean))return setNote('Введите номер в международном формате, например +49123456789.');setSaving(true);const now=new Date().toISOString();const {error}=await supabase.from('profiles').update({display_name:name.trim(),phone:clean||null,bio:bio.trim(),status_mode:statusMode,status:statusMode==='auto'?'online':statusMode,last_seen:now,updated_at:now}).eq('id',p.id);setSaving(false);if(error)alert(error.message);else{await refreshProfile();setRefresh(v=>v+1);setNote('Настройки сохранены ✅')}}
  const choosePreset=async e=>{const {error}=await supabase.from('profiles').update({avatar_url:presetAvatar(e),updated_at:new Date().toISOString()}).eq('id',p.id);if(error)alert(error.message);else{await refreshProfile();setRefresh(v=>v+1)}}
  const unblock=async id=>{const {error}=await supabase.from('blocked_users').delete().eq('blocker_id',session.user.id).eq('blocked_id',id);if(error)alert(error.message);else loadBlocked()}
  return <div className="settings"><div className="settings-header"><SectionLabel icon={<I.Settings/>}>Настройки</SectionLabel><button className="outline settings-back" onClick={onBack}>← К чатам</button></div><div className="settings-card"><label>Имя<input value={name} onChange={e=>setName(e.target.value)}/></label><label>Статус<select value={statusMode} onChange={e=>setStatusMode(e.target.value)}><option value="auto">Автоматически — В сети / Не в сети</option><option value="online">В сети</option><option value="away">Отошёл</option><option value="dnd">Не беспокоить</option><option value="offline">Не в сети</option></select></label><small className="muted">Автоматически = в сети при открытом Nexly и не в сети после закрытия. «Не беспокоить» блокирует входящие звонки.</small><label>Номер телефона<input value={phone} onChange={e=>setPhone(e.target.value.replace(/[^0-9+()\-\s]/g,''))} placeholder="необязательно"/><small className="muted">Проверяется только формат; SMS-проверка не используется.</small></label><label>О себе<textarea value={bio} onChange={e=>setBio(e.target.value)} rows="4"/></label><div className="preset-grid">{PRESETS.map(x=><button type="button" key={x} onClick={()=>choosePreset(x)}>{x}</button>)}</div>{note&&<div className={note.includes('✅')?'success-box':'error-box'}>{note}</div>}<button className="primary" onClick={save} disabled={saving}>{saving?<span className="spinner small"/>:<I.Save/>}Сохранить</button></div><AvatarUpload profile={p} setRefresh={setRefresh}/><div className="settings-card"><div className="settings-card-title"><I.Lock/> Заблокированные пользователи</div>{blocked.length?blocked.map(r=><div className="blocked-row" key={r.blocked_id}><img src={r.profiles?.avatar_url||fallbackAvatar(r.profiles?.display_name||r.profiles?.username)}/><div className="grow"><b>{r.profiles?.display_name||r.profiles?.username}</b><small>@{r.profiles?.username}</small></div><button className="outline" onClick={()=>unblock(r.blocked_id)}>Разблокировать</button></div>):<div className="muted">Нет заблокированных пользователей.</div>}</div><GameHistory session={session}/></div>
}

function GameHistory({ session }) {
  const [items,setItems]=useState([])
  useEffect(()=>{let active=true;supabase.from('game_matches').select('id,game,winner_id,player1_id,player2_id,created_at').or(`player1_id.eq.${session.user.id},player2_id.eq.${session.user.id}`).order('created_at',{ascending:false}).limit(20).then(({data})=>{if(active)setItems(data||[])});return()=>{active=false}},[session.user.id])
  return <div className="settings-card"><div className="settings-card-title">🎮 История игр</div>{items.length?items.map(m=><div className="history-row" key={m.id}><span>{GAME_META[m.game]?.icon} {GAME_META[m.game]?.label}</span><b>{m.winner_id===session.user.id?'Победа':m.winner_id?'Поражение':'Ничья'}</b></div>):<div className="muted">Матчей пока нет.</div>}</div>
}

function AvatarUpload({ profile, setRefresh }) {
  const ref = useRef(null)
  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return alert('Выбери изображение.')
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase()
      const path = `${profile.id}/avatar-${crypto.randomUUID()}.${ext}`
      const { error } = await supabase.storage.from('nexly-media').upload(path, file, { upsert: false, contentType: file.type, cacheControl: '3600' })
      if (error) throw error
      const { data } = supabase.storage.from('nexly-media').getPublicUrl(path)
      const { error: pe } = await supabase.from('profiles').update({ avatar_url: data.publicUrl, updated_at: new Date().toISOString() }).eq('id', profile.id)
      if (pe) throw pe
      setRefresh(v => v + 1)
    } catch (e2) {
      alert('Не удалось загрузить аватар: ' + (e2.message || e2))
    }
  }
  return <div className="settings-card"><button className="outline full" onClick={() => ref.current?.click()}><I.Camera />Загрузить аватар</button><input hidden type="file" accept="image/*" ref={ref} onChange={upload} /></div>
}

function NewGroupModal({ session, contacts = [], onClose, onDone }) {
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[sel,setSel]=useState([]),[busy,setBusy]=useState(false)
  const [groupContacts,setGroupContacts]=useState(contacts)
  const [friendsLoading,setFriendsLoading]=useState(true)
  const [avatarFile,setAvatarFile]=useState(null)
  const [avatarPreview,setAvatarPreview]=useState('')
  const avatarRef=useRef(null)

  useEffect(()=>{
    let active=true
    setFriendsLoading(true)
    loadFriendProfiles(session.user.id).then(list=>{
      if(active){setGroupContacts(list.map(other=>({type:'direct',other})));setFriendsLoading(false)}
    }).catch(()=>{if(active){setGroupContacts(contacts||[]);setFriendsLoading(false)}})
    return()=>{active=false}
  },[session.user.id])

  useEffect(()=>{
    setSel([])
    setAvatarFile(null)
    setAvatarPreview('')
  },[])

  useEffect(()=>()=>{ if(avatarPreview?.startsWith('blob:')) URL.revokeObjectURL(avatarPreview) },[avatarPreview])

  const chooseAvatar=e=>{
    const file=e.target.files?.[0]
    e.target.value=''
    if(!file)return
    if(!file.type.startsWith('image/'))return alert('Выбери изображение.')
    if(avatarPreview?.startsWith('blob:'))URL.revokeObjectURL(avatarPreview)
    setAvatarFile(file)
    setAvatarPreview(URL.createObjectURL(file))
  }

  const create=async()=>{
    if(!title.trim()||busy)return
    setBusy(true)
    const {data,error}=await supabase.rpc('create_group',{p_title:title.trim(),p_description:description.trim()||null,p_member_ids:sel})
    if(error){alert('Не удалось создать группу: '+error.message);setBusy(false);return}

    let avatarUrl=groupAvatar
    if(avatarFile){
      try{
        const ext=(avatarFile.name.split('.').pop()||'png').toLowerCase()
        const path=`${session.user.id}/groups/${data}-${crypto.randomUUID()}.${ext}`
        const {error:upError}=await supabase.storage.from('nexly-media').upload(path,avatarFile,{upsert:false,contentType:avatarFile.type,cacheControl:'3600'})
        if(upError)throw upError
        const {data:publicData}=supabase.storage.from('nexly-media').getPublicUrl(path)
        avatarUrl=publicData.publicUrl
        const {error:updateError}=await supabase.from('conversations').update({avatar_url:avatarUrl,updated_at:new Date().toISOString()}).eq('id',data)
        if(updateError)throw updateError
      }catch(e){
        alert('Группа создана, но фото не удалось загрузить: '+(e.message||e))
      }
    }

    setBusy(false)
    onDone({id:data,type:'group',title:title.trim(),description:description.trim()||null,avatar_url:avatarUrl,owner_id:session.user.id})
  }

  return <div className="modal-backdrop">
    <div className="modal group-create-modal">
      <div className="modal-head"><div><h3>Новая группа</h3><div className="muted small">Настрой название, описание и фото</div></div><button className="icon-btn" onClick={onClose}><I.X/></button></div>
      <div className="group-create-avatar-block">
        <button type="button" className="group-create-avatar-button" onClick={()=>avatarRef.current?.click()} title="Изменить фото группы">
          <img className="group-create-avatar-preview" src={avatarPreview||groupAvatar} alt="Фото группы" />
          <span className="group-create-avatar-edit"><I.Camera/>Изменить фото</span>
        </button>
        <input hidden ref={avatarRef} type="file" accept="image/*" onChange={chooseAvatar}/>
      </div>
      <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Название группы"/>
      <textarea className="group-description-input" value={description} onChange={e=>setDescription(e.target.value)} placeholder="Описание — необязательно" rows="3"/>
      <div className="group-select-count">Выбрано: <b>{sel.length}</b> из <b>{groupContacts.length}</b></div>
      <div className="modal-scroll group-select-list">{friendsLoading?<div className="muted group-no-friends-note">Загрузка друзей…</div>:groupContacts.map(c=>{const u=c.other;return <label className="check-row" key={u.id}><input type="checkbox" checked={sel.includes(u.id)} onChange={()=>setSel(a=>a.includes(u.id)?a.filter(x=>x!==u.id):[...a,u.id])}/><img src={u.avatar_url||fallbackAvatar(u.display_name||u.username)}/><span><b>{u.display_name||u.username}</b><small>@{u.username} · {statusText(u.status)}</small></span></label>})}{!friendsLoading&&!groupContacts.length&&<div className="muted group-no-friends-note">У вас пока нет друзей. Группу можно создать без них и добавить позже.</div>}</div>
      <button className="primary" onClick={create} disabled={busy||!title.trim()}>{busy?'Создание…':'Создать группу'}</button>
    </div>
  </div>
}
function GroupManageModal({ group, session, members, onClose, onChanged }) {
  const [allFriends,setAllFriends]=useState([])
  const [friendsLoading,setFriendsLoading]=useState(true)
  const [saving,setSaving]=useState(false)

  const loadFriends=async()=>{
    setFriendsLoading(true)
    try {
      const list=await loadFriendProfiles(session.user.id)
      setAllFriends(list)
    } finally {
      setFriendsLoading(false)
    }
  }

  useEffect(()=>{ loadFriends() },[session.user.id,group.id])

  const existing=new Set(members.map(m=>m.user_id))

  const addPerson=async id=>{
    if(!id||existing.has(id))return
    setSaving(true)
    const {error}=await supabase.rpc('add_group_members',{p_conversation_id:group.id,p_member_ids:[id]})
    setSaving(false)
    if(error){
      alert(error.message)
      return
    }
    await Promise.resolve(onChanged?.())
    await loadFriends()
  }
  const updateMember=async(member,patch)=>{
    setSaving(true)
    const current={p_conversation_id:group.id,p_user_id:member.user_id,p_role:patch.role??member.role,p_banned:patch.banned??member.banned,p_can_send:patch.can_send??member.can_send}
    const {error}=await supabase.rpc('set_group_member_permissions',current)
    setSaving(false)
    if(error)alert(error.message);else onChanged()
  }
  const removeMember=async(member)=>{
    if(!confirm(`Удалить @${member.profiles?.username||'пользователя'} из группы?`))return
    setSaving(true)
    const {error}=await supabase.rpc('remove_group_member',{p_conversation_id:group.id,p_user_id:member.user_id})
    setSaving(false)
    if(error)alert(error.message);else onChanged()
  }
  return <div className="modal-backdrop nested"><div className="modal group-manage-modal"><div className="modal-head"><div><h3>Участники группы</h3><div className="muted small">Добавление и права доступа</div></div><button className="icon-btn" onClick={onClose}><I.X/></button></div><div className="group-members-admin">{members.map(m=><div className="group-admin-row" key={m.user_id}><img src={m.profiles?.avatar_url||fallbackAvatar(m.profiles?.display_name||m.profiles?.username)}/><div className="grow"><b>{m.profiles?.display_name||m.profiles?.username}</b><small>@{m.profiles?.username}</small></div><select value={m.role} onChange={e=>updateMember(m,{role:e.target.value})} disabled={saving||m.user_id===session.user.id}><option value="member">Участник</option><option value="admin">Администратор</option></select><label className="toggle-mini"><input type="checkbox" checked={m.can_send} onChange={e=>updateMember(m,{can_send:e.target.checked})} disabled={saving||m.user_id===session.user.id}/><span>Писать</span></label><label className="toggle-mini"><input type="checkbox" checked={m.banned} onChange={e=>updateMember(m,{banned:e.target.checked})} disabled={saving||m.user_id===session.user.id}/><span>Бан</span></label><button className="mini-btn no" onClick={()=>removeMember(m)} disabled={saving||m.user_id===session.user.id}><I.Trash2/></button></div>)}</div><div className="group-add-block"><h4>Добавить друзей</h4><div className="group-add-grid">{friendsLoading?<div className="muted">Загрузка друзей…</div>:allFriends.filter(u=>!existing.has(u.id)).map(u=><button key={u.id} className="group-add-person" onClick={()=>addPerson(u.id)} disabled={saving}><img src={u.avatar_url||fallbackAvatar(u.display_name||u.username)}/><span><b>{u.display_name||u.username}</b><small>@{u.username}</small></span><I.Plus/></button>)}{!friendsLoading&&!allFriends.length&&<div className="muted">Пока нет друзей.</div>}{!friendsLoading&&allFriends.length>0&&!allFriends.some(u=>!existing.has(u.id))&&<div className="muted">Все друзья уже в группе.</div>}</div></div></div></div>
}

function ChatPanel({ selected, profile, session, setInfoOpen, refresh, setRefresh, onCall, notificationsEnabled }) {
  const [msgs,setMsgs]=useState([]),[text,setText]=useState(''),[reply,setReply]=useState(null),[editing,setEditing]=useState(null),[context,setContext]=useState(null),[typing,setTyping]=useState(false),[mediaBusy,setMediaBusy]=useState(false),[emojiOpen,setEmojiOpen]=useState(false),[recording,setRecording]=useState(false),[recordLocked,setRecordLocked]=useState(false),[recordSeconds,setRecordSeconds]=useState(0),[pinned,setPinned]=useState(null),[forwardMessage,setForwardMessage]=useState(null),[circleOpen,setCircleOpen]=useState(false),[circleRecording,setCircleRecording]=useState(false),[circleSeconds,setCircleSeconds]=useState(0),[blockedByMe,setBlockedByMe]=useState(false),[gamePicker,setGamePicker]=useState(false),[reactionRows,setReactionRows]=useState([])
  const end=useRef(null),mediaRef=useRef(null),chunks=useRef([]),recordStartY=useRef(0),recordTimer=useRef(null),recordLockedRef=useRef(false),recordCancelled=useRef(false),fileRef=useRef(null),gifRef=useRef(null),chatChannel=useRef(null),circleVideoRef=useRef(null),circleStreamRef=useRef(null),circleRecorderRef=useRef(null),circleTimerRef=useRef(null),messageIdsRef=useRef(new Set())
  const convId=selected?.id
  const load=async()=>{if(!convId){setMsgs([]);setPinned(null);setReactionRows([]);messageIdsRef.current=new Set();return}const {data,error}=await supabase.from('messages').select('*').eq('conversation_id',convId).order('created_at');if(error)return console.error(error);const loaded=data||[];setMsgs(loaded);messageIdsRef.current=new Set(loaded.map(m=>m.id));try{await supabase.rpc('mark_conversation_read',{p_conversation_id:convId})}catch{}setPinned([...loaded].reverse().find(m=>m.pinned)||null);if(loaded.length){const {data:rr}=await supabase.from('message_reactions').select('message_id,user_id,reaction').in('message_id',loaded.map(m=>m.id));setReactionRows(rr||[])}else setReactionRows([]);if(selected?.type==='direct'&&selected.other?.id){setBlockedByMe(await isBlockedBetween(session.user.id, selected.other.id))}else setBlockedByMe(false)}
  const syncLatest=async()=>{if(!convId)return;const {data}=await supabase.from('messages').select('*').eq('conversation_id',convId).order('created_at');if(!data)return;setMsgs(prev=>{const map=new Map(prev.map(m=>[m.id,m]));for(const row of data)map.set(row.id,row);const next=[...map.values()].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));messageIdsRef.current=new Set(next.map(m=>m.id));return next});setPinned(prev=>{const latest=[...data].reverse().find(m=>m.pinned);return latest||((prev&&data.some(m=>m.id===prev.id&&m.pinned===false))?null:prev)})}
  useEffect(()=>{load();setReply(null);setEditing(null);setContext(null);setEmojiOpen(false);setGamePicker(false)},[convId,refresh])
  useEffect(()=>{if(!convId)return;let active=true;const ch=supabase.channel('chat-'+convId).on('postgres_changes',{event:'*',schema:'public',table:'messages',filter:`conversation_id=eq.${convId}`},p=>{if(!active)return;if(p.eventType==='INSERT'){setMsgs(a=>a.some(m=>m.id===p.new.id)?a:[...a,p.new]);messageIdsRef.current.add(p.new.id);if(p.new.pinned)setPinned(p.new);if(p.new.sender_id!==session.user.id&&notificationsEnabled)notifyIncoming('Nexly',p.new.content||'Новое сообщение')}if(p.eventType==='UPDATE'){setMsgs(a=>a.map(m=>m.id===p.new.id?p.new:m));setPinned(prev=>p.new.pinned?p.new:(prev?.id===p.new.id?null:prev))}if(p.eventType==='DELETE'){setMsgs(a=>a.filter(m=>m.id!==p.old.id));messageIdsRef.current.delete(p.old.id);setPinned(prev=>prev?.id===p.old.id?null:prev)}}).on('broadcast',{event:'message'},({payload})=>{const row=payload?.message;if(!row||row.conversation_id!==convId||(row.sender_id===session.user.id&&messageIdsRef.current.has(row.id)))return;setMsgs(a=>a.some(m=>m.id===row.id)?a:[...a,row]);messageIdsRef.current.add(row.id);if(row.sender_id!==session.user.id&&notificationsEnabled)notifyIncoming('Nexly',row.content||'Новое сообщение')}).on('postgres_changes',{event:'*',schema:'public',table:'message_reactions'},p=>{const row=p.eventType==='DELETE'?p.old:p.new;if(!row||!messageIdsRef.current.has(row.message_id))return;if(p.eventType==='INSERT'){setReactionRows(a=>a.some(x=>x.message_id===row.message_id&&x.user_id===row.user_id&&x.reaction===row.reaction)?a:[...a,row])}else if(p.eventType==='UPDATE'){setReactionRows(a=>a.map(x=>x.message_id===row.message_id&&x.user_id===row.user_id&&x.reaction===row.reaction?row:x))}else if(p.eventType==='DELETE'){setReactionRows(a=>a.filter(x=>!(x.message_id===row.message_id&&x.user_id===row.user_id&&x.reaction===row.reaction)))}}).on('broadcast',{event:'typing'},({payload})=>{if(payload?.user_id===session.user.id)return;setTyping(Boolean(payload?.typing));clearTimeout(window.__nexlyTypingTimer);if(payload?.typing)window.__nexlyTypingTimer=setTimeout(()=>setTyping(false),1800)}).subscribe(status=>{if(status==='SUBSCRIBED')chatChannel.current=ch});const timer=setInterval(()=>syncLatest(),3000);return()=>{active=false;clearInterval(timer);chatChannel.current=null;supabase.removeChannel(ch)}},[convId,session.user.id,notificationsEnabled])
  useEffect(()=>{if(!convId||!chatChannel.current)return;chatChannel.current.send({type:'broadcast',event:'typing',payload:{user_id:session.user.id,typing:Boolean(text)}})},[text,convId,session.user.id])
  useEffect(()=>{end.current?.scrollIntoView({behavior:'smooth'})},[msgs,typing])
  const joinGroupCallFromMessage = async (callId) => {
    if (!callId || selected?.type !== 'group' || !onCall) return

    const { data: callRow, error } = await supabase
      .from('call_sessions')
      .select('id,conversation_id,kind,status,expires_at')
      .eq('id', callId)
      .maybeSingle()

    if (error) return alert('Не удалось открыть звонок: ' + error.message)
    if (!callRow || callRow.conversation_id !== selected.id || !['ringing','active'].includes(callRow.status)) {
      return alert('Этот групповой звонок уже завершён.')
    }
    if (callRow.expires_at && new Date(callRow.expires_at).getTime() <= Date.now()) {
      return alert('Этот групповой звонок уже завершён.')
    }

    await onCall(selected, callRow.kind === 'video')
  }

  const send=async(customText=null,customReply=reply)=>{const value=String(customText??text).trim();if(!value||!convId||mediaBusy)return;if(value.toLowerCase()==='/play'){if(selected?.type!=='direct'||!selected.other?.id)return alert('Команда /play работает только в личном чате с другом.');if(blockedByMe)return alert('Игра с заблокированным пользователем недоступна.');setGamePicker(true);setText('');return}if(editing){const {error}=await supabase.from('messages').update({content:value,edited:true,updated_at:new Date().toISOString()}).eq('id',editing.id).eq('sender_id',session.user.id);if(error)alert(error.message);else{setEditing(null);await syncLatest()}}else{const {data,error}=await supabase.from('messages').insert({conversation_id:convId,sender_id:session.user.id,content:value,reply_to:customReply?.id||null}).select('*').single();if(error)alert(error.message);else{setMsgs(a=>a.some(m=>m.id===data.id)?a:[...a,data]);messageIdsRef.current.add(data.id);setReply(null);try{await chatChannel.current?.send({type:'broadcast',event:'message',payload:{message:data}})}catch{}}}setText('')}
  const doAction=async(action,m)=>{if(action==='reply'){setReply(m);setContext(null)}else if(action==='edit'){setEditing(m);setText(m.content||'');setContext(null)}else if(action==='delete'){const {error}=await supabase.from('messages').delete().eq('id',m.id).eq('sender_id',session.user.id);if(error)alert(error.message);setContext(null)}else if(action==='forward'){setForwardMessage(m);setContext(null)}else if(action==='pin'){const {error}=await supabase.from('messages').update({pinned:!m.pinned,updated_at:new Date().toISOString()}).eq('id',m.id);if(error)alert(error.message);else setPinned(m.pinned?null:m);setContext(null)}}
  const scrollToMessage=id=>requestAnimationFrame(()=>document.getElementById(`message-${id}`)?.scrollIntoView({behavior:'smooth',block:'center'}))
  const toggleReaction=async(m,emoji)=>{if(!m?.id||!emoji)return;const existing=reactionRows.find(r=>r.message_id===m.id&&r.user_id===session.user.id&&r.reaction===emoji);if(existing){const {error}=await supabase.from('message_reactions').delete().eq('message_id',m.id).eq('user_id',session.user.id).eq('reaction',emoji);if(error)return alert('Не удалось убрать реакцию: '+error.message);setReactionRows(a=>a.filter(r=>r!==existing))}else{const {data,error}=await supabase.from('message_reactions').insert({message_id:m.id,user_id:session.user.id,reaction:emoji}).select('message_id,user_id,reaction').single();if(error)return alert('Не удалось поставить реакцию: '+error.message);setReactionRows(a=>a.some(r=>r.message_id===m.id&&r.user_id===session.user.id&&r.reaction===emoji)?a:[...a,(data||{message_id:m.id,user_id:session.user.id,reaction:emoji})])}setContext(null)}
  const uploadFile=async(file,forcedType=null)=>{if(!file||!convId)return;setMediaBusy(true);try{const ext=(file.name.split('.').pop()||'bin').toLowerCase(),path=`${session.user.id}/messages/${crypto.randomUUID()}.${ext}`;const {error}=await supabase.storage.from('nexly-media').upload(path,file,{upsert:false,contentType:file.type||'application/octet-stream'});if(error)throw error;const {data}=supabase.storage.from('nexly-media').getPublicUrl(path);const type=forcedType||(file.type==='image/gif'?'gif':file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':'file');const {error:me}=await supabase.from('messages').insert({conversation_id:convId,sender_id:session.user.id,content:type==='gif'?'GIF':type==='image'?'Фото':type==='video'?'Видео':file.name,attachments:{type,url:data.publicUrl,name:file.name,mime:file.type}});if(me)throw me}catch(e){alert('Не удалось отправить файл: '+(e.message||e))}finally{setMediaBusy(false)}}
  const sendLocation=()=>{if(!navigator.geolocation)return alert('Геолокация не поддерживается.');navigator.geolocation.getCurrentPosition(async pos=>{const {latitude,longitude}=pos.coords;const {error}=await supabase.from('messages').insert({conversation_id:convId,sender_id:session.user.id,content:'Геолокация',attachments:{type:'location',lat:latitude,lng:longitude,url:`https://www.google.com/maps?q=${latitude},${longitude}`}});if(error)alert(error.message)},err=>alert(err.message),{enableHighAccuracy:true})}
  const sendGifUrl=async()=>{if(!convId)return;const url=prompt('Вставь прямую ссылку на GIF');if(!url||!/^https?:\/\/.*(\.gif|giphy\.com|tenor\.com)/i.test(url))return;if(mediaBusy)return;const {error}=await supabase.from('messages').insert({conversation_id:convId,sender_id:session.user.id,content:'GIF',attachments:{type:'gif',url}});if(error)alert(error.message)}
  const finishVoice=cancelled=>{recordCancelled.current=cancelled;if(mediaRef.current?.state!=='inactive')mediaRef.current?.stop()}
  const beginVoice=async()=>{if(recording||blockedByMe)return;if(!mediaSupported())return alert(browserMediaError());try{const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});const mime=recorderMime('audio'),rec=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);chunks.current=[];mediaRef.current=rec;recordCancelled.current=false;recordLockedRef.current=false;setRecordLocked(false);setRecording(true);setRecordSeconds(0);rec.ondataavailable=e=>e.data.size&&chunks.current.push(e.data);rec.onstop=async()=>{clearInterval(recordTimer.current);stream.getTracks().forEach(t=>t.stop());setRecording(false);setRecordLocked(false);if(recordCancelled.current||!chunks.current.length)return;const blob=new Blob(chunks.current,{type:rec.mimeType||'audio/webm'}),file=new File([blob],`voice-${crypto.randomUUID()}.${blob.type.includes('ogg')?'ogg':'webm'}`,{type:blob.type});await uploadFile(file,'audio')};rec.start(200);recordTimer.current=setInterval(()=>setRecordSeconds(s=>s+1),1000)}catch(e){alert(browserMediaError(e))}}
  const pointerDown=e=>{recordStartY.current=e.clientY;beginVoice()};const pointerMove=e=>{if(recording&&!recordLockedRef.current&&recordStartY.current-e.clientY>70){recordLockedRef.current=true;setRecordLocked(true)}};const pointerUp=()=>{if(recording&&!recordLockedRef.current)finishVoice(false)};const recordCancel=()=>{if(recording)finishVoice(true)}
  const startCircle=async()=>{if(circleOpen||blockedByMe)return;if(!mediaSupported())return alert(browserMediaError());try{const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:true});circleStreamRef.current=stream;if(circleVideoRef.current)circleVideoRef.current.srcObject=stream;const mime=recorderMime('video'),rec=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream),parts=[];circleRecorderRef.current=rec;setCircleOpen(true);setCircleRecording(true);setCircleSeconds(0);rec.ondataavailable=e=>e.data.size&&parts.push(e.data);rec.onstop=async()=>{clearInterval(circleTimerRef.current);stream.getTracks().forEach(t=>t.stop());circleStreamRef.current=null;setCircleRecording(false);setCircleOpen(false);if(!parts.length)return;const blob=new Blob(parts,{type:rec.mimeType||'video/webm'}),file=new File([blob],`circle-${crypto.randomUUID()}.webm`,{type:blob.type});await uploadFile(file,'video-circle')};rec.start(200);circleTimerRef.current=setInterval(()=>setCircleSeconds(s=>{if(s>=9){rec.stop();return 10}return s+1}),1000)}catch(e){alert(browserMediaError(e))}}
  if(!selected)return <section className="chat-panel"><div className="chat-empty"><div className="hero-badge">N</div><h2>Выберите чат</h2><p>Выберите диалог слева, чтобы начать общение.</p></div></section>
  const otherName=selected.type==='group'?selected.title:(selected.other?.display_name||selected.other?.username||'Чат'),subtitle=selected.type==='group'?'Группа':statusText(selected.other?.status)
  return <section className="chat-panel"><header className="chat-head"><img src={selected.type==='group'?(selected.avatar_url||groupAvatar):(selected.other?.avatar_url||fallbackAvatar(selected.other?.username))}/><div className="grow"><b>{otherName}</b><small>{subtitle}</small></div><button className="icon-btn" title="Аудиозвонок" onClick={()=>onCall?.(selected,false)} disabled={blockedByMe&&selected.type==='direct'}><I.Phone/></button><button className="icon-btn" title="Видеозвонок" onClick={()=>onCall?.(selected,true)} disabled={blockedByMe&&selected.type==='direct'}><I.Video/></button><button className="icon-btn" title="Информация" onClick={()=>setInfoOpen(true)}><I.MoreVertical/></button></header>{blockedByMe&&selected.type==='direct'&&<div className="blocked-banner"><I.Lock/> Вы заблокировали @{selected.other.username}. Писать ему нельзя.</div>}{pinned&&<button className="pinned-bar" onClick={()=>scrollToMessage(pinned.id)}><I.Pin/><span className="grow"><b>Закреплено</b><small>{pinned.content||'Медиа'}</small></span><I.ChevronDown/></button>}<div className="feed" onClick={()=>setContext(null)}>{msgs.map(m=>{const grouped={};for(const r of reactionRows.filter(r=>r.message_id===m.id)){if(!grouped[r.reaction])grouped[r.reaction]={emoji:r.reaction,count:0,mine:false};grouped[r.reaction].count++;if(r.user_id===session.user.id)grouped[r.reaction].mine=true}return <MessageBubble key={m.id} m={m} own={m.sender_id===session.user.id} replyMessage={m.reply_to?msgs.find(x=>x.id===m.reply_to):null} reactions={Object.values(grouped)} onContext={setContext} onReply={setReply} onNavigate={scrollToMessage} onReact={emoji=>toggleReaction(m,emoji)} onJoinGroupCall={joinGroupCallFromMessage}/>})}{typing&&<div className="typing"><span/><span/><span/>Печатает…</div>}<div ref={end}/></div>{context&&<ContextMenu x={context.x} y={context.y} own={context.msg.sender_id===session.user.id} pinned={context.msg.pinned} on={a=>doAction(a,context.msg)} onReact={emoji=>toggleReaction(context.msg,emoji)}/> } {reply&&<div className="reply-bar"><I.Reply/><div className="grow"><small>Ответ на сообщение</small><div>{reply.content||'Медиа'}</div></div><button className="icon-btn" onClick={()=>setReply(null)}><I.X/></button></div>} {editing&&<div className="edit-bar"><I.Pencil/><div className="grow">Редактирование сообщения</div><button className="icon-btn" onClick={()=>{setEditing(null);setText('')}}><I.X/></button></div>}<div className="composer-wrap">{emojiOpen&&<div className="emoji-popover">{EMOJIS.map(e=><button key={e} type="button" onClick={()=>setText(t=>t+e)}>{e}</button>)}<button className="emoji-gif" onClick={sendGifUrl}>GIF URL</button></div>}{recording&&<div className="record-pill"><div className="record-dot"/><span>{recordLocked?'Запись зафиксирована':'Запись…'} {recordSeconds}s</span><button className="voice-action" onClick={()=>finishVoice(false)}>Отправить</button><button className="voice-action cancel" onClick={()=>finishVoice(true)}>Отмена</button></div>}<div className="composer"><div className="composer-actions"><label className="icon-btn"><I.Paperclip/><input hidden ref={fileRef} type="file" accept="image/*,video/*,.pdf,.zip,.txt,.doc,.docx,.xls,.xlsx" onChange={e=>{const f=e.target.files?.[0];e.target.value='';uploadFile(f)}}/></label><label className="icon-btn"><I.CircleDot/><input hidden ref={gifRef} type="file" accept="image/gif" onChange={e=>{const f=e.target.files?.[0];e.target.value='';uploadFile(f,'gif')}}/></label><button className="icon-btn" onClick={sendLocation}><I.MapPin/></button><button className="icon-btn" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={recordCancel} disabled={blockedByMe}><I.Mic/></button><button className="icon-btn" onClick={startCircle} disabled={blockedByMe}><I.Video/></button><button className={cls('icon-btn',emojiOpen&&'active')} onClick={()=>setEmojiOpen(v=>!v)}><I.Smile/></button></div><input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}} placeholder="Написать сообщение…" disabled={blockedByMe}/><button className="send-btn" onClick={()=>send()} disabled={!text.trim()||mediaBusy||blockedByMe}><I.Send/></button></div></div>{circleOpen&&<div className="circle-recorder-backdrop"><div className="circle-recorder"><div className="circle-recorder-head"><b>Видео-кружок</b><span>{circleSeconds}с</span></div><div className="circle-preview-wrap"><video ref={circleVideoRef} className="circle-preview" playsInline muted autoPlay/></div><div className="circle-controls"><button className="voice-action cancel" onClick={()=>{circleRecorderRef.current?.stop();if(!circleRecorderRef.current)setCircleOpen(false)}}>Отмена</button><div className="circle-live-dot"/><span>{circleRecording?'Запись… до 10с':'Готово'}</span></div></div></div>}{forwardMessage&&<ForwardModal session={session} message={forwardMessage} onClose={()=>setForwardMessage(null)} onDone={()=>setForwardMessage(null)}/>} {gamePicker&&<GamePickerModal target={selected} session={session} onClose={()=>setGamePicker(false)} onSent={()=>setGamePicker(false)}/>}</section>
}

function AudioMessage({ src }) {
  const audio = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)

  const toggle = async () => {
    if (!audio.current) return
    if (audio.current.paused) {
      try {
        await audio.current.play()
        setPlaying(true)
      } catch {
        setPlaying(false)
      }
    } else {
      audio.current.pause()
      setPlaying(false)
    }
  }

  const pretty = (seconds) => {
    const total = Math.max(0, Math.floor(seconds || 0))
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }

  return <div className="audio-message">
    <audio
      ref={audio}
      src={src+'?download=1'}
      preload="none"
      onLoadedMetadata={() => setDuration(audio.current?.duration || 0)}
      onTimeUpdate={() => setProgress(audio.current?.currentTime || 0)}
      onEnded={() => { setPlaying(false); setProgress(0) }}
    />
    <button type="button" className="audio-play" onClick={toggle} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>{playing ? 'Ⅱ' : '▶'}</button>
    <div className="audio-track-wrap">
      <input className="audio-track" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(progress, duration || 1)} onChange={e => { if (audio.current) { audio.current.currentTime = Number(e.target.value); setProgress(audio.current.currentTime) } }} aria-label="Позиция голосового сообщения" />
      <div className="audio-time"><span>{pretty(progress)}</span><span>{pretty(duration)}</span></div>
    </div>
    <I.Mic />
  </div>
}

function NexlyReplyQuoteStyles() {
  return <style>{`
    .nexly-reply-quote {
      transition: transform .16s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease;
    }
    .nexly-reply-quote:hover {
      transform: translateY(-1px);
      border-color: rgba(167,139,250,.48) !important;
      background: linear-gradient(135deg, rgba(124,58,237,.24), rgba(18,18,28,.82)) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 7px 20px rgba(124,58,237,.14) !important;
    }
    .nexly-reply-quote:focus-visible {
      outline: 2px solid rgba(167,139,250,.72);
      outline-offset: 2px;
    }
  `}</style>
}

function MessageBubble({ m, own, replyMessage, onContext, onReply, onNavigate, reactions = [], onReact, onJoinGroupCall }) {
  const hold = useRef()
  const ctx = e => { e.preventDefault(); onContext({ msg: m, x: e.clientX, y: e.clientY }) }
  const touchStart = e => { hold.current = setTimeout(() => onContext({ msg: m, x: Math.min(e.touches[0].clientX, innerWidth - 220), y: Math.min(e.touches[0].clientY, innerHeight - 300) }), 520) }
  const touchEnd = () => clearTimeout(hold.current)
  const a = m.attachments || {}
  const audioBubble = a.type === 'audio'
  return <>
    <NexlyReplyQuoteStyles />
    <div id={`message-${m.id}`} className={cls('bubble-row', own && 'own')} onContextMenu={ctx} onTouchStart={touchStart} onTouchEnd={touchEnd} onTouchMove={touchEnd}>
      <div className={cls('bubble', own && 'mine', audioBubble && 'audio-bubble')}>
        {replyMessage && <button
          type="button"
          className="quoted quoted-link nexly-reply-quote"
          onClick={() => onNavigate(replyMessage.id)}
          title="Перейти к сообщению, на которое дан ответ"
          style={{
            display: 'grid', gridTemplateColumns: '4px 20px minmax(0, 1fr)', alignItems: 'center', gap: 9,
            width: '100%', margin: '0 0 8px', padding: '8px 10px', border: '1px solid rgba(139,92,246,.22)', borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(124,58,237,.16), rgba(17,17,24,.72))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.045), 0 4px 14px rgba(0,0,0,.12)',
            color: 'inherit', textAlign: 'left', cursor: 'pointer', overflow: 'hidden'
          }}
        >
          <span aria-hidden="true" style={{ width: 4, height: 36, borderRadius: 99, background: 'linear-gradient(180deg,#a78bfa,#7c3aed)', boxShadow: '0 0 10px rgba(124,58,237,.4)' }} />
          <span aria-hidden="true" style={{ width: 20, height: 20, display: 'grid', placeItems: 'center', borderRadius: 7, background: 'rgba(139,92,246,.18)', color: '#a78bfa', fontSize: 14, fontWeight: 800 }}>↩</span>
          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 11, lineHeight: 1.15, fontWeight: 800, color: '#a78bfa', letterSpacing: '.01em' }}>Ответ на сообщение</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, lineHeight: 1.35, color: 'rgba(255,255,255,.72)' }}>
              {replyMessage.content || (replyMessage.attachments?.type === 'image' ? '📷 Фото' : replyMessage.attachments?.type === 'video' ? '🎬 Видео' : replyMessage.attachments?.type === 'audio' ? '🎤 Голосовое сообщение' : 'Медиа')}
            </span>
          </span>
        </button>}
        {a.type === 'image' && <img src={a.url} className="msg-image" alt="Фото" loading="lazy" />}
        {a.type === 'gif' && <img src={a.url} className="msg-image" alt="GIF" loading="lazy" />}
        {a.type === 'video' && <video src={a.url+'?download=1'} controls className="msg-video" preload="none" onError={e=>{e.currentTarget.setAttribute('data-media-error','1')}} />}
        {a.type === 'audio' && <AudioMessage src={a.url} />}
        {a.type === 'video-circle' && <video src={a.url+'?download=1'} controls playsInline className="msg-circle" preload="none" onError={e=>e.currentTarget.setAttribute('data-media-error','1')} />}
        {a.type === 'location' && <a href={a.url} target="_blank" rel="noreferrer" className="location-card"><I.MapPin /><div><b>Местоположение</b><small>{Number(a.lat).toFixed(4)}, {Number(a.lng).toFixed(4)}</small></div></a>}
        {a.type === 'file' && <a href={a.url} target="_blank" rel="noreferrer" className="file-card"><I.File />{a.name || 'Файл'}</a>}
        {a.type === 'call' && a.groupCall && <div style={{marginTop:2,padding:14,borderRadius:16,border:'1px solid rgba(139,92,246,.22)',background:'linear-gradient(135deg,rgba(124,58,237,.14),rgba(15,15,22,.84))'}}>
          <div style={{display:'flex',alignItems:'center',gap:11,marginBottom:10}}>
            <div style={{width:42,height:42,borderRadius:13,display:'grid',placeItems:'center',background:'rgba(124,58,237,.22)',fontSize:21}}>📞</div>
            <div style={{minWidth:0,flex:1}}>
              <b style={{display:'block',fontSize:14}}>Групповой звонок</b>
              <span style={{display:'block',marginTop:2,fontSize:12,color:'rgba(255,255,255,.62)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{m.content || 'Кто-то начал групповой звонок'}</span>
            </div>
          </div>
          <button type="button" className="primary full" onClick={() => onJoinGroupCall?.(a.callId)} style={{display:'flex',justifyContent:'center',alignItems:'center',gap:8}}>
            <I.Phone /> Присоединиться
          </button>
        </div>}
        {m.content && (!a.type || a.type === 'location' || a.type === 'file' || a.type === 'video-circle') && <div>{m.content}</div>}
        {reactions.length>0&&<div className="message-reactions">{reactions.map(r=><button key={r.emoji} type="button" className={cls('message-reaction',r.mine&&'mine')} onClick={e=>{e.stopPropagation();onReact?.(r.emoji)}}><span>{r.emoji}</span><b>{r.count}</b></button>)}</div>}
        <div className="bubble-meta">{m.edited ? 'изменено · ' : ''}{fmt(m.created_at)}{m.pinned && <I.Pin />}</div>
      </div>
      <button className="bubble-reply icon-btn" onClick={() => onReply(m)} title="Ответить"><I.Reply /></button>
    </div>
  </>
}

function ContextMenu({ x, y, own, pinned, on, onReact }) {
  const [showMore,setShowMore]=useState(false)
  const width=showMore?342:324
  return <div
    className={cls('context-menu','reaction-context',showMore&&'expanded')}
    style={{left:Math.max(8,Math.min(x,innerWidth-width-8)),top:Math.max(8,Math.min(y,innerHeight-(showMore?410:260)-8))}}
    onClick={e=>e.stopPropagation()}
    onPointerDown={e=>e.stopPropagation()}
  >
    <div className="reaction-bar">
      {QUICK_REACTIONS.map(emoji=><button key={emoji} type="button" className="reaction-quick" onClick={()=>onReact?.(emoji)}>{emoji}</button>)}
      <button type="button" className={cls('reaction-arrow',showMore&&'open')} onClick={()=>setShowMore(v=>!v)} title="Все реакции">⌄</button>
    </div>
    {showMore&&<div className="reaction-grid">{REACTION_EMOJIS.map(emoji=><button key={emoji} type="button" onClick={()=>onReact?.(emoji)}>{emoji}</button>)}</div>}
    <div className="reaction-menu-divider"/>
    <div className="reaction-actions">
      <button onClick={() => on('reply')}><I.Reply />Ответить</button>
      {own && <><button onClick={() => on('edit')}><I.Pencil />Изменить</button><button onClick={() => on('delete')}><I.Trash2 />Удалить</button></>}
      <button onClick={() => on('forward')}><I.Forward />Переслать</button>
      <button onClick={() => on('pin')}><I.Pin />{pinned ? 'Открепить' : 'Закрепить'}</button>
    </div>
  </div>
}
function ForwardModal({ session, message, onClose, onDone }) {
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let active = true
    const load = async () => {
      const { data: memberships } = await supabase.from('conversation_members').select('conversation_id,conversations(id,type,title,description,avatar_url)').eq('user_id', session.user.id).eq('banned', false)
      const list = memberships || []
      const ids = list.map(x => x.conversation_id)
      let members = []
      if (ids.length) {
        const { data } = await supabase.from('conversation_members').select('conversation_id,user_id,profiles(id,username,display_name,avatar_url)').in('conversation_id', ids)
        members = data || []
      }
      const result = list.map(item => {
        const c = item.conversations
        if (!c) return null
        if (c.type === 'group') return { ...c, label: c.title || 'Группа', avatar: c.avatar_url }
        const other = members.find(m => m.conversation_id === item.conversation_id && m.user_id !== session.user.id)?.profiles
        return { ...c, label: other?.display_name || other?.username || 'Чат', avatar: other?.avatar_url }
      }).filter(Boolean)
      if (active) { setConversations(result); setLoading(false) }
    }
    load()
    return () => { active = false }
  }, [session.user.id])

  const forwardTo = async (conversationId) => {
    setSending(true)
    const { error } = await supabase.from('messages').insert({ conversation_id: conversationId, sender_id: session.user.id, content: message.content || '', attachments: message.attachments || null })
    setSending(false)
    if (error) return alert('Не удалось переслать: ' + error.message)
    onDone()
  }

  return <div className="modal-backdrop"><div className="modal forward-modal"><div className="modal-head"><div><h3>Переслать сообщение</h3><div className="muted small">Выберите чат</div></div><button className="icon-btn" onClick={onClose}><I.X /></button></div><div className="modal-scroll">{loading ? <div className="boot">Загрузка…</div> : conversations.map(c => <button key={c.id} className="forward-row" onClick={() => forwardTo(c.id)} disabled={sending}><img src={c.avatar || fallbackAvatar(c.label)} /><div className="grow"><b>{c.label}</b><small>{c.type === 'group' ? 'Группа' : 'Личный чат'}</small></div><I.Forward /></button>)}{!loading && !conversations.length && <EmptySide text="Нет доступных чатов" />}</div></div></div>
}

function InfoPanel({ open, selected, session, onCall, onClose }) {
  const [blocked,setBlocked]=useState(false)
  const [loading,setLoading]=useState(false)
  const [sharedGroups,setSharedGroups]=useState([])
  const [sharedMedia,setSharedMedia]=useState([])
  const [groupMembers,setGroupMembers]=useState([])
  const [manageOpen,setManageOpen]=useState(false)

  useEffect(()=>{
    let active=true
    const run=async()=>{
      if(!selected){
        setBlocked(false)
        setSharedGroups([])
        setSharedMedia([])
        setGroupMembers([])
        return
      }

      if(selected.type==='group'){
        const {data,error}=await supabase
          .from('conversation_members')
          .select('user_id,role,banned,can_send,profiles(id,username,display_name,avatar_url,phone,bio,status)')
          .eq('conversation_id',selected.id)
        if(error) console.warn('Group members:',error.message)
        if(active)setGroupMembers(data||[])
        return
      }

      if(!selected.other?.id){
        setBlocked(false)
        return
      }

      setBlocked(await isBlockedBetween(session.user.id,selected.other.id))

      const {data:mine}=await supabase
        .from('conversation_members')
        .select('conversation_id,conversations!inner(id,type,title,avatar_url)')
        .eq('user_id',session.user.id)
        .eq('conversations.type','group')

      const {data:theirs}=await supabase
        .from('conversation_members')
        .select('conversation_id')
        .eq('user_id',selected.other.id)

      const theirsSet=new Set((theirs||[]).map(x=>x.conversation_id))
      const common=(mine||[])
        .filter(x=>theirsSet.has(x.conversation_id))
        .map(x=>x.conversations)
        .filter(Boolean)

      if(active)setSharedGroups(common)

      const {data:media}=await supabase
        .from('messages')
        .select('id,attachments,created_at')
        .eq('conversation_id',selected.id)
        .order('created_at',{ascending:false})
        .limit(50)

      const mediaRows=(media||[])
        .filter(m=>['image','video','gif','video-circle'].includes(m.attachments?.type))
        .slice(0,8)

      if(active)setSharedMedia(mediaRows)
    }

    run()
    return()=>{active=false}
  },[selected?.id,selected?.other?.id,session.user.id])

  if(!open)return null

  if(!selected){
    return <aside className="info-panel">
      <div className="info-head">
        <span>Информация</span>
        <button className="icon-btn" onClick={onClose}><I.X/></button>
      </div>
      <div className="info-empty">Выберите чат</div>
    </aside>
  }

  const target=selected.type==='group'?null:selected.other
  const groupAdmin=selected.type==='group' && (
    selected.owner_id===session.user.id ||
    groupMembers.some(m=>m.user_id===session.user.id && m.role==='admin' && !m.banned)
  )

  const toggleBlock=async()=>{
    if(!target?.id)return
    setLoading(true)
    try{
      if(blocked){
        const {error}=await supabase.rpc('unblock_user',{target_user_id:target.id})
        if(error)throw error
        setBlocked(false)
      }else{
        if(!confirm(`Заблокировать @${target.username}?`))return
        const {error}=await supabase.rpc('block_user',{target_user_id:target.id})
        if(error)throw error
        setBlocked(true)
      }
    }catch(e){
      alert(e.message||'Не удалось изменить блокировку')
    }finally{
      setLoading(false)
    }
  }

  return <aside className="info-panel">
    <div className="info-head">
      <span>Информация</span>
      <button className="icon-btn" onClick={onClose}><I.X/></button>
    </div>

    <div className="contact-card">
      <img
        className="contact-avatar"
        src={selected.type==='group' ? (selected.avatar_url||groupAvatar) : (target?.avatar_url||fallbackAvatar(target?.username))}
      />

      <h3>{selected.type==='group' ? selected.title : (target?.display_name||target?.username)}</h3>

      {target&&<>
        <div className="muted">@{target.username}</div>
        <div className={cls('status-dot',target.status==='online'&&'live')}>{statusText(target.status)}</div>

        <div className="contact-actions">
          <button title="Аудиозвонок" onClick={()=>onCall?.(selected,false)} disabled={blocked}><I.Phone/></button>
          <button title="Видеозвонок" onClick={()=>onCall?.(selected,true)} disabled={blocked}><I.Video/></button>
          <button title="Скопировать ID" onClick={()=>navigator.clipboard?.writeText('@'+target.username).then(()=>alert('ID скопирован'))}><I.AtSign/></button>
        </div>

        <div className="contact-detail">
          <b>Телефон</b>
          <span>
            {target.phone||'не указан'}
            {target.phone&&<small className="muted"> · {target.phone_verified?'подтверждён':'не подтверждён'}</small>}
          </span>
        </div>

        <div className="contact-detail">
          <b>О себе</b>
          <span>{target.bio||'Нет описания'}</span>
        </div>

        <button className="outline full" onClick={toggleBlock} disabled={loading}>
          <I.Lock/>{blocked?'Разблокировать пользователя':'Заблокировать пользователя'}
        </button>

        <div className="shared-info">
          <div className="contact-detail">
            <b>Общие группы</b>
            <span>{sharedGroups.length ? sharedGroups.map(g=>g.title||'Группа').join(', ') : 'Нет общих групп'}</span>
          </div>

          <div className="contact-detail">
            <b>Общие медиа</b>
            {sharedMedia.length ? <div className="media-grid">
              {sharedMedia.map(m=>m.attachments?.type==='video'||m.attachments?.type==='video-circle'
                ? <video key={m.id} src={(m.attachments.url||'')+'?download=1'} muted playsInline controls preload="none" />
                : <img key={m.id} src={m.attachments?.url} alt="Медиа" />
              )}
            </div> : <span>В этом чате пока нет фото и видео.</span>}
          </div>
        </div>
      </>}

      {selected.type==='group'&&<div className="group-info">
        <div className="contact-detail">
          <b>Описание</b>
          <span>{selected.description||'Группа Nexly'}</span>
        </div>

        <div className="contact-detail">
          <b>Участники</b>
          <div className="group-members-list">
            {groupMembers.map(m=>{
              const u=m.profiles||{}
              return <div className={cls('group-member-chip',m.banned&&'member-banned')} key={m.user_id} title={`@${u.username||''}`}>
                <img src={u.avatar_url||fallbackAvatar(u.display_name||u.username)}/>
                <span>@{u.username||'user'}</span>
                {m.role==='admin'&&<small>админ</small>}
                {m.banned&&<small>бан</small>}
              </div>
            })}
          </div>
        </div>

        <div className="contact-actions">
          <button title="Групповой аудиозвонок" onClick={()=>onCall?.(selected,false)}><I.Phone/></button>
          <button title="Групповой видеозвонок" onClick={()=>onCall?.(selected,true)}><I.Video/></button>
        </div>

        {groupAdmin&&<button className="outline full" onClick={()=>setManageOpen(true)}>
          <I.Users/>Участники и права
        </button>}
      </div>}
    </div>

    {manageOpen&&<GroupManageModal
      group={selected}
      session={session}
      members={groupMembers}
      onClose={()=>setManageOpen(false)}
      onChanged={async()=>{
        const {data}=await supabase.from('conversation_members').select('user_id,role,banned,can_send,profiles(id,username,display_name,avatar_url,phone,bio,status)').eq('conversation_id',selected.id)
        setGroupMembers(data||[])
      }}
    />}
  </aside>
}

function CallModal({ call, session, onClose }) {
  const isGroup = Boolean(call.isGroup)
  const target = call.target?.other || call.caller || call.allowed?.[0]
  const incoming = Boolean(call.incoming)
  const autoJoin = Boolean(call.autoJoin)
  const [accepted, setAccepted] = useState(Boolean(!incoming))
  const [video, setVideo] = useState(Boolean(call.video))
  const [muted, setMuted] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [participants, setParticipants] = useState(() => {
    const ids = [session.user.id]
    if (isGroup) ids.push(...(call.allowed || []).map(x => x?.id).filter(Boolean))
    else if (target?.id) ids.push(target.id)
    return new Set(ids.filter(Boolean))
  })
  const [participantProfiles, setParticipantProfiles] = useState(() => {
    const map = {
      [session.user.id]: {
        id: session.user.id,
        username: session.user.user_metadata?.username || '',
        display_name: session.user.user_metadata?.display_name || '',
        avatar_url: session.user.user_metadata?.avatar_url || ''
      }
    }
    if (isGroup) {
      for (const p of (call.allowed || [])) {
        if (p?.id) map[p.id] = p
      }
    } else if (target?.id) {
      map[target.id] = target
    }
    return map
  })
  const [videoReady, setVideoReady] = useState(new Set())

  const local = useRef(null)
  const remotes = useRef(new Map())
  const peers = useRef(new Map())
  const streamRef = useRef(null)
  const channel = useRef(null)
  const ringTimer = useRef(null)
  const ringCounter = useRef(null)
  const toneRef = useRef(null)
  const closed = useRef(false)
  const started = useRef(false)
  const acceptedRef = useRef(accepted)
  const participantsRef = useRef(participants)

  useEffect(() => { acceptedRef.current = accepted }, [accepted])
  useEffect(() => { participantsRef.current = participants }, [participants])

  const key = `call-${call.callId}`
  const stopTone = () => {
    try {
      toneRef.current?.pause()
      if (toneRef.current) toneRef.current.currentTime = 0
    } catch {}
  }

  const cleanup = () => {
    stopTone()
    stopIncomingCallTone()
    clearTimeout(ringTimer.current)
    clearInterval(ringCounter.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    for (const pc of peers.current.values()) pc.close()
    peers.current.clear()
    if (channel.current) supabase.removeChannel(channel.current)
    channel.current = null
    if (call.inviteChannel) {
      try { supabase.removeChannel(call.inviteChannel) } catch {}
    }
  }

  const signal = async (payload) => {
    if (!channel.current) return
    try {
      await channel.current.send({
        type: 'broadcast',
        event: 'signal',
        payload: { from: session.user.id, ...payload }
      })
    } catch {}
  }

  const createPeer = async (id) => {
    if (!id || id === session.user.id) return null

    if (peers.current.has(id)) {
      const existing = peers.current.get(id)
      if (existing && streamRef.current) {
        const currentTracks = new Set(
          existing.getSenders().map(sender => sender.track?.id).filter(Boolean)
        )
        for (const track of streamRef.current.getTracks()) {
          if (!currentTracks.has(track.id)) existing.addTrack(track, streamRef.current)
        }
      }
      return existing
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    })

    peers.current.set(id, pc)
    streamRef.current?.getTracks().forEach(t => pc.addTrack(t, streamRef.current))
    pc.onicecandidate = e => {
      if (e.candidate) signal({ kind: 'ice', to: id, candidate: e.candidate })
    }
    pc.ontrack = e => {
      const el = remotes.current.get(id)
      if (el) el.srcObject = e.streams[0]
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setConnected(true)
      if (pc.connectionState === 'failed') setError('Не удалось установить соединение. Проверь сеть и доступ к камере/микрофону.')
    }
    return pc
  }

  const makeOffer = async (id) => {
    if (!id || session.user.id >= id) return
    const pc = await createPeer(id)
    if (!pc || pc.signalingState !== 'stable') return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await signal({ kind: 'offer', to: id, sdp: offer })
  }

  const end = async (reason = 'hangup') => {
    if (closed.current) return
    closed.current = true
    try {
      if (isGroup && session.user.id !== call.callerId) {
        const { error } = await supabase.rpc('leave_call', { p_call_id: call.callId })
        if (error) console.warn('leave_call:', error.message)
        await signal({ kind: 'leave' })
      } else {
        await signal({ kind: 'hangup' })
        const { error } = await supabase.rpc('end_call', { p_call_id: call.callId })
        if (error) console.warn('end_call:', error.message)
      }
    } catch (e) {
      console.warn('Call end:', e?.message || e)
    }
    cleanup()
    onClose()
  }

  useEffect(() => {
    let active = true
    const ch = supabase
      .channel(key)
      .on('broadcast', { event: 'signal' }, async ({ payload }) => {
        if (!active || !payload || payload.from === session.user.id || (payload.to && payload.to !== session.user.id)) return
        try {
          if (payload.kind === 'accept' && !isGroup) {
            setAccepted(true)
            acceptedRef.current = true
            stopTone()
          } else if (payload.kind === 'join' && isGroup) {
            stopTone()
            if (!acceptedRef.current) {
              setAccepted(true)
              acceptedRef.current = true
            }

            const n = new Set(participantsRef.current)
            n.add(payload.from)
            participantsRef.current = n
            setParticipants(n)

            if (payload.profile?.id) {
              setParticipantProfiles(prev => ({ ...prev, [payload.profile.id]: payload.profile }))
            }

            await signal({ kind: 'roster', participants: [...n].filter(Boolean) })

            if (streamRef.current) {
              for (const id of n) {
                if (id !== session.user.id) await makeOffer(id)
              }
            }
          } else if (payload.kind === 'roster' && isGroup) {
            const n = new Set(participantsRef.current)
            for (const id of (payload.participants || [])) n.add(id)
            n.add(session.user.id)
            participantsRef.current = n
            setParticipants(n)

            if (acceptedRef.current && streamRef.current) {
              for (const id of n) {
                if (id !== session.user.id) await makeOffer(id)
              }
            }
          } else if (payload.kind === 'offer') {
            if (incoming && !acceptedRef.current) return
            const pc = await createPeer(payload.from)
            if (!pc) return
            await pc.setRemoteDescription(payload.sdp)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await signal({ kind: 'answer', to: payload.from, sdp: answer })
          } else if (payload.kind === 'answer') {
            const pc = peers.current.get(payload.from)
            if (pc && pc.signalingState !== 'stable') await pc.setRemoteDescription(payload.sdp)
          } else if (payload.kind === 'ice') {
            if (incoming && !acceptedRef.current) return
            const pc = peers.current.get(payload.from) || await createPeer(payload.from)
            if (pc) {
              try { await pc.addIceCandidate(payload.candidate) } catch {}
            }
          } else if (['reject', 'cancel', 'timeout'].includes(payload.kind)) {
            if (isGroup) {
              setParticipants(prev => { const n = new Set(prev); n.delete(payload.from); participantsRef.current=n; return n })
              peers.current.get(payload.from)?.close()
              peers.current.delete(payload.from)
            } else {
              closed.current = true
              cleanup()
              onClose()
            }
          } else if (payload.kind === 'hangup') {
            closed.current = true
            cleanup()
            onClose()
          } else if (payload.kind === 'leave' && isGroup) {
            setParticipants(prev => {
              const n = new Set(prev)
              n.delete(payload.from)
              participantsRef.current = n
              return n
            })
            peers.current.get(payload.from)?.close()
            peers.current.delete(payload.from)
          }
        } catch (e) {
          if (active) setError(e.message || 'Ошибка звонка')
        }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') channel.current = ch
      })

    channel.current = ch
    return () => {
      active = false
      if (!closed.current) cleanup()
    }
  }, [key, incoming, isGroup])

  useEffect(() => {
    if (!isGroup || !call.callId || !accepted) return
    let active = true

    const sameSet = (a,b) => a.size === b.size && [...a].every(id => b.has(id))

    const syncRoster = async () => {
      const { data, error } = await supabase
        .from('call_participants')
        .select('user_id,status,profiles(id,username,display_name,avatar_url)')
        .eq('call_id', call.callId)
        .eq('status', 'connected')

      if (!active || error) return

      const next = new Set((data || []).map(row => row.user_id).filter(Boolean))
      next.add(session.user.id)

      if (!sameSet(participantsRef.current, next)) {
        participantsRef.current = next
        setParticipants(next)
      }

      const profileMap = {}
      for (const row of data || []) {
        if (row.profiles?.id) profileMap[row.profiles.id] = row.profiles
      }
      if (Object.keys(profileMap).length) {
        setParticipantProfiles(prev => ({ ...prev, ...profileMap }))
      }

      if (streamRef.current) {
        for (const id of next) {
          if (id !== session.user.id) await makeOffer(id)
        }
      }
    }

    syncRoster()
    const timer = setInterval(syncRoster, 1500)

    return () => {
      active = false
      clearInterval(timer)
    }
  }, [isGroup, call.callId, accepted])

  // Ring only while the call is unanswered. 60 seconds instead of 15.
  useEffect(() => {
    if (accepted || closed.current) return
    const a = new Audio(incoming ? '/sounds/iphone_x.mp3' : '/sounds/phone-ringing-sound.mp3')
    a.loop = true
    a.volume = 0.85
    toneRef.current = a
    a.play().catch(() => {})
    ringCounter.current = setInterval(() => setSeconds(s => s + 1), 1000)
    ringTimer.current = setTimeout(() => end('timeout'), CALL_RING_TIMEOUT_MS)
    return () => {
      clearTimeout(ringTimer.current)
      clearInterval(ringCounter.current)
      try { a.pause() } catch {}
    }
  }, [accepted, incoming])

  useEffect(() => {
    if (!accepted || started.current) return
    started.current = true
    stopTone()
    let active = true
    const start = async () => {
      if (!mediaSupported()) return setError(browserMediaError())
      try {
        const st = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: video ? { facingMode: 'user' } : false
        })
        if (!active) {
          st.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = st
        if (local.current) local.current.srcObject = st

        if (isGroup) {
          setConnected(true)
          const meProfile={
            id:session.user.id,
            username:session.user.user_metadata?.username||'',
            display_name:session.user.user_metadata?.display_name||'',
            avatar_url:session.user.user_metadata?.avatar_url||''
          }
          await signal({
            kind:'join',
            profile:meProfile,
            participants:[...participantsRef.current]
          })
          for (const id of participantsRef.current) {
            if (id !== session.user.id) await makeOffer(id)
          }
        } else if (target?.id) {
          const pc = await createPeer(target.id)
          if (session.user.id < target.id) {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            await signal({ kind: 'offer', to: target.id, sdp: offer })
          }
        }
      } catch (e) {
        if (active) setError(browserMediaError(e))
      }
    }
    start()
    return () => { active = false }
  }, [accepted])

  const answer = async () => {
    stopTone()
    try {
      const { data, error } = await supabase.rpc('answer_call', { p_call_id: call.callId })
      if (error) { setError(error.message); return }
      if (data === false) { setError('Этот звонок уже завершён или истёк.'); return }
      setAccepted(true)
      acceptedRef.current = true
      if (!isGroup) await signal({ kind: 'accept' })
    } catch (e) {
      setError(e.message || 'Не удалось принять звонок')
    }
  }

  const reject = async () => {
    try {
      if (isGroup) {
        const { error } = await supabase.rpc('reject_call', { p_call_id: call.callId })
        if (error) { setError(error.message); return }
        await signal({ kind: 'leave' })
      } else {
        const { error } = await supabase.rpc('reject_call', { p_call_id: call.callId })
        if (error) { setError(error.message); return }
        await signal({ kind: 'reject' })
      }
      cleanup()
      onClose()
    } catch (e) {
      setError(e.message || 'Не удалось отклонить звонок')
    }
  }

  const toggleVideo = async () => {
    try {
      if (!streamRef.current) return
      const t = streamRef.current.getVideoTracks()[0]
      if (t) {
        t.enabled = !t.enabled
        setVideo(t.enabled)
        return
      }
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      const vt = st.getVideoTracks()[0]
      streamRef.current.addTrack(vt)
      for (const pc of peers.current.values()) pc.addTrack(vt, streamRef.current)
      if (local.current) local.current.srcObject = streamRef.current
      setVideo(true)
    } catch (e) {
      setError(browserMediaError(e))
    }
  }

  const share = async () => {
    try {
      const st = await navigator.mediaDevices.getDisplayMedia({ video: true })
      const t = st.getVideoTracks()[0]
      for (const pc of peers.current.values()) {
        const s = pc.getSenders().find(x => x.track?.kind === 'video')
        if (s) await s.replaceTrack(t)
      }
      setSharing(true)
      t.onended = async () => {
        const cam = streamRef.current?.getVideoTracks()?.[0]
        for (const pc of peers.current.values()) {
          const s = pc.getSenders().find(x => x.track?.kind === 'video')
          if (s && cam) await s.replaceTrack(cam)
        }
        setSharing(false)
      }
    } catch (e) {
      setError(e.message || 'Демонстрация экрана недоступна')
    }
  }

  if (incoming && !accepted) return (
    <div className="call-backdrop">
      <div className="incoming-call-card">
        <img src={target?.avatar_url || fallbackAvatar(target?.display_name || target?.username)} />
        <h2>{target?.display_name || target?.username || call.group?.title}</h2>
        <p>{isGroup ? 'Входящий групповой звонок' : (video ? 'Входящий видеозвонок' : 'Входящий звонок')} · {seconds}с</p>
        {error && <div className="error-box">{error}</div>}
        <div className="incoming-actions">
          <button className="call-btn danger" onClick={reject}><I.PhoneOff /></button>
          <button className="call-btn answer" onClick={answer}><I.Phone /></button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="call-backdrop">
      <div className="call-card">
        <div className="call-top">
          <div>
            <b>{isGroup ? call.group?.title : (target?.display_name || target?.username || 'Звонок')}</b>
            <small>{connected ? 'Подключено' : `Вызов… ${seconds}с`} {isGroup && `· участников: ${participants.size}`}</small>
          </div>
          <button className="icon-btn" onClick={() => end('hangup')}><I.X /></button>
        </div>
        {error && <div className="error-box" style={{ margin: 10 }}>{error}</div>}
        <style>{`
          .nexly-group-call-stage{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;padding:10px;background:#111218;min-height:360px;align-items:stretch}
          .nexly-group-tile{position:relative;overflow:hidden;min-height:190px;border:1px solid #2d2f39;border-radius:18px;background:linear-gradient(145deg,#1a1c24,#101117);box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
          .nexly-group-tile video{width:100%;height:100%;min-height:190px;object-fit:cover;display:block;background:#0d0e12}
          .nexly-group-placeholder{position:absolute;inset:0;display:grid;place-items:center;background:radial-gradient(circle at 50% 35%,rgba(124,58,237,.20),rgba(8,9,13,.96) 68%);transition:opacity .18s ease}
          .nexly-group-placeholder.video-ready{opacity:0}
          .nexly-group-placeholder img{width:74px;height:74px;border-radius:50%;object-fit:cover;border:2px solid rgba(167,139,250,.50);box-shadow:0 8px 28px rgba(0,0,0,.32)}
          .nexly-group-name{position:absolute;left:10px;right:10px;bottom:10px;padding:7px 10px;border-radius:10px;background:rgba(8,9,13,.72);backdrop-filter:blur(10px);font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .nexly-group-me{position:absolute;top:10px;right:10px;padding:5px 8px;border-radius:9px;background:rgba(124,58,237,.88);font-size:10px;font-weight:800}
          @media(max-width:700px){.nexly-group-call-stage{grid-template-columns:1fr 1fr}.nexly-group-tile,.nexly-group-tile video{min-height:150px}}
          @media(max-width:480px){.nexly-group-call-stage{grid-template-columns:1fr}.nexly-group-tile,.nexly-group-tile video{min-height:190px}}
        `}</style>
        <div className={cls('call-video-grid', !video && 'audio-mode', isGroup && 'group-call-grid', isGroup && 'nexly-group-call-stage')}>
          {isGroup ? (
            [...participants].map(id => {
              const p = participantProfiles[id] || {id,display_name:id===session.user.id?'Вы':'Участник',username:''}
              const name = p.display_name || p.username || (id===session.user.id ? 'Вы' : 'Участник')
              const avatar = p.avatar_url || fallbackAvatar(name)

              return <div key={id} className="nexly-group-tile">
                {id !== session.user.id
                  ? <video
                      ref={el => { if (el) remotes.current.set(id,el); else remotes.current.delete(id) }}
                      playsInline
                      autoPlay
                      className="remote-tile"
                      onLoadedData={() => setVideoReady(prev => new Set(prev).add(id))}
                  />
                  : <video
                      ref={local}
                      playsInline
                      autoPlay
                      muted
                      className="local-video"
                      onLoadedData={() => setVideoReady(prev => new Set(prev).add(id))}
                  />}
                <div className={cls('nexly-group-placeholder', videoReady.has(id) && video && 'video-ready')} aria-hidden="true">
                  <img src={avatar} alt="" />
                  {!video && <span style={{position:'absolute',marginTop:118,fontSize:28}}>🎙️</span>}
                </div>
                <div className="nexly-group-name">{name}</div>
                {id===session.user.id && <div className="nexly-group-me">ВЫ</div>}
              </div>
            })
          ) : (
            <>
              <video ref={el => { if (el && target?.id) remotes.current.set(target.id,el) }} playsInline autoPlay className="remote-video" />
              <video ref={local} playsInline autoPlay muted className="local-video" />
              {!video && <div className="call-avatar"><img src={target?.avatar_url || fallbackAvatar(target?.username)} /></div>}
            </>
          )}
        </div>
        <div className="call-controls">
          <button className={cls('call-btn', muted && 'off')} onClick={() => { const t = streamRef.current?.getAudioTracks?.()[0]; if (t) { t.enabled = !t.enabled; setMuted(!t.enabled) } }}>{muted ? <I.MicOff /> : <I.Mic />}</button>
          <button className={cls('call-btn', !video && 'off')} onClick={toggleVideo}><I.Video /></button>
          <button className="call-btn" onClick={share}>{sharing ? <I.Square /> : <I.MonitorUp />}</button>
          <button className="call-btn danger" onClick={() => end('hangup')}><I.PhoneOff /></button>
        </div>
      </div>
    </div>
  )
}

function GameInviteModal({ invite, session, onClose, onAccept }) {
  const [busy,setBusy]=useState(false); const meta=GAME_META[invite.game]||GAME_META.rps
  const accept=async()=>{setBusy(true);const inviteId=invite.id||crypto.randomUUID();if(invite.id)await supabase.from('game_invites').update({status:'accepted',updated_at:new Date().toISOString()}).eq('id',invite.id).eq('receiver_id',session.user.id);const ch=supabase.channel(`games-inbox-${invite.from}`);ch.subscribe(async st=>{if(st==='SUBSCRIBED'){await ch.send({type:'broadcast',event:'response',payload:{to:invite.from,from:session.user.id,status:'accepted',invite_id:inviteId,game:invite.game}});setTimeout(()=>supabase.removeChannel(ch),3000)}});onAccept({...invite,inviteId,opponent:invite.sender,incoming:true});setBusy(false)}
  const reject=async()=>{const inviteId=invite.id||crypto.randomUUID();if(invite.id)await supabase.from('game_invites').update({status:'rejected',updated_at:new Date().toISOString()}).eq('id',invite.id).eq('receiver_id',session.user.id);const ch=supabase.channel(`games-inbox-${invite.from}`);ch.subscribe(async st=>{if(st==='SUBSCRIBED'){await ch.send({type:'broadcast',event:'response',payload:{to:invite.from,from:session.user.id,status:'rejected',invite_id:inviteId,game:invite.game}});setTimeout(()=>supabase.removeChannel(ch),3000)}});onClose()}
  return <div className="modal-backdrop"><div className="modal game-invite-modal"><div className="modal-head"><div><h3>{meta.icon} {meta.label}</h3><div className="muted">{invite.sender?.display_name||invite.sender?.username} приглашает вас сыграть</div></div><button className="icon-btn" onClick={onClose}><I.X/></button></div><div className="game-invite-body"><img src={invite.sender?.avatar_url||fallbackAvatar(invite.sender?.display_name||invite.sender?.username)}/><div><b>@{invite.sender?.username}</b><p className="muted">{meta.description}</p></div></div><div className="incoming-actions"><button className="call-btn danger" onClick={reject}><I.X/></button><button className="call-btn answer" onClick={accept} disabled={busy}><I.Check/></button></div></div></div>
}
function GamePickerModal({ target, session, onClose, onSent }) {
  const sendInvite=async(game)=>{if(await isBlockedBetween(session.user.id, target.other.id))return alert('Игра недоступна: пользователь заблокирован.');const id=crypto.randomUUID();const {data:inserted}=await supabase.from('game_invites').insert({id,sender_id:session.user.id,receiver_id:target.other.id,conversation_id:target.id,game,status:'pending'}).select('id').single();const ch=supabase.channel(`games-inbox-${target.other.id}`);ch.subscribe(async st=>{if(st==='SUBSCRIBED'){await ch.send({type:'broadcast',event:'invite',payload:{id:inserted?.id||id,from:session.user.id,to:target.other.id,game,conversation_id:target.id}});setTimeout(()=>supabase.removeChannel(ch),5000)}});onSent()}
  return <div className="modal-backdrop"><div className="modal"><div className="modal-head"><div><h3>Выбери игру</h3><div className="muted">Команда /play отправляет игровой вызов.</div></div><button className="icon-btn" onClick={onClose}><I.X/></button></div><div className="game-picker-grid">{Object.entries(GAME_META).map(([key,meta])=><button key={key} className="game-card" onClick={()=>sendInvite(key)}><span>{meta.icon}</span><b>{meta.label}</b><small>{meta.description}</small></button>)}</div></div></div>
}
const RACE_CSS = String.raw`
.nx-race-shell{position:relative;width:min(1120px,96vw);min-height:min(760px,92vh);overflow:hidden;border:1px solid #3a3a44;border-radius:28px;background:#b8733f;box-shadow:0 30px 100px #000b;isolation:isolate}
.nx-race-shell:before{content:"";position:absolute;inset:0;background-color:#b8733f;background-image:linear-gradient(#ffffff10 1px,transparent 1px),linear-gradient(90deg,#ffffff10 1px,transparent 1px),linear-gradient(135deg,#8d4f2b14 25%,transparent 25%,transparent 50%,#8d4f2b14 50%,#8d4f2b14 75%,transparent 75%);background-size:58px 30px,58px 30px,116px 60px;opacity:.9;z-index:-2}
.nx-race-shell:after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 50% 38%,transparent 0 42%,#25150d1f 68%,#130b081d 100%);pointer-events:none;z-index:-1}
.nx-race-top{position:absolute;left:22px;right:22px;top:18px;display:flex;align-items:center;justify-content:space-between;z-index:8;pointer-events:none}
.nx-race-score{display:flex;gap:10px;align-items:center;padding:9px 13px;border:1px solid #ffffff2a;border-radius:15px;background:#0c0d10d9;backdrop-filter:blur(12px);box-shadow:0 10px 30px #0004;color:#fff;font-size:12px;font-weight:800}
.nx-race-score .dot{width:9px;height:9px;border-radius:50%;background:#51d64b;box-shadow:0 0 12px #51d64b}
.nx-race-score b{font-size:14px}
.nx-race-close{pointer-events:auto!important}
.nx-race-stage{position:relative;margin:74px 28px 102px;min-height:500px;aspect-ratio:1000/620}
.nx-race-track{position:absolute;inset:0;width:100%;height:100%;filter:drop-shadow(0 20px 26px #0008)}
.nx-race-track path{vector-effect:non-scaling-stroke}
.nx-race-finish{position:absolute;left:50%;top:14.2%;transform:translateX(-50%);width:26px;height:78px;border:2px solid #15171a;border-radius:3px;background:repeating-conic-gradient(#fff 0 25%,#1d1f23 0 50%) 50%/13px 13px;box-shadow:0 3px 10px #0008;z-index:6}
.nx-race-start-light{position:absolute;left:50%;top:4.7%;transform:translateX(-50%);display:flex;gap:6px;padding:7px 11px;border-radius:12px;border:2px solid #1f2023;background:#0b0c0dd9;box-shadow:0 7px 18px #0008;z-index:7}
.nx-race-start-light span{width:11px;height:11px;border-radius:50%;background:#2d3036;border:1px solid #fff1;box-shadow:inset 0 1px 2px #fff2}
.nx-race-start-light.go span{background:#71e048;box-shadow:0 0 14px #71e048}
.nx-race-status{position:absolute;left:50%;top:11.4%;transform:translateX(-50%);z-index:7;padding:7px 13px;border-radius:999px;background:#111317dd;border:1px solid #ffffff26;color:#fff;font-weight:900;font-size:12px;letter-spacing:.02em;white-space:nowrap;box-shadow:0 6px 18px #0005}
.nx-race-lane-glow{position:absolute;inset:0;pointer-events:none;z-index:2}
.nx-race-car{position:absolute;width:34px;height:62px;transform-origin:50% 50%;z-index:8;will-change:transform;filter:drop-shadow(0 8px 8px #0009)}
.nx-race-car .body{position:absolute;inset:4px 5px;border-radius:12px 12px 9px 9px;background:linear-gradient(180deg,#f74f56,#b3151d);border:2px solid #551217;box-shadow:inset 0 4px 7px #fff4}
.nx-race-car.blue .body{background:linear-gradient(180deg,#559aff,#1e4ed9);border-color:#142968}
.nx-race-car .hood{position:absolute;left:9px;right:9px;top:5px;height:20px;border-radius:8px 8px 4px 4px;background:#bcd4e6aa;border:1px solid #fff6}
.nx-race-car.blue .hood{background:#cfe0ff9c}
.nx-race-car .window{position:absolute;left:10px;right:10px;top:20px;height:14px;border-radius:4px;background:#0e1522cc;border:1px solid #fff3}
.nx-race-car .wheel{position:absolute;top:9px;bottom:8px;width:6px;border-radius:4px;background:#17181b;box-shadow:0 8px 0 #17181b,0 16px 0 #17181b}
.nx-race-car .wheel.left{left:1px}.nx-race-car .wheel.right{right:1px}
.nx-race-car .stripe{position:absolute;left:50%;top:4px;bottom:6px;width:4px;transform:translateX(-50%);border-radius:4px;background:#fff8}
.nx-race-car.me .body{box-shadow:0 0 18px #ff4d5444,inset 0 4px 7px #fff4}
.nx-race-car.opp .body{box-shadow:0 0 18px #4e86ff44,inset 0 4px 7px #fff4}
.nx-race-label{position:absolute;z-index:10;padding:5px 9px;border-radius:9px;background:#0d0f12c9;border:1px solid #ffffff20;color:#fff;font-size:10px;font-weight:900;white-space:nowrap;backdrop-filter:blur(8px);pointer-events:none}
.nx-race-hud{position:absolute;left:28px;right:28px;bottom:18px;display:flex;align-items:center;gap:12px;z-index:20}
.nx-race-meter{min-width:210px;padding:10px 12px;border:1px solid #ffffff20;background:#101114d9;border-radius:15px;color:#fff;backdrop-filter:blur(12px)}
.nx-race-meter-row{display:flex;justify-content:space-between;gap:10px;font-size:11px;font-weight:800}
.nx-race-meter strong{font-size:16px}
.nx-race-bar{height:7px;border-radius:99px;background:#ffffff14;overflow:hidden;margin-top:8px}
.nx-race-bar>span{display:block;height:100%;width:0;background:linear-gradient(90deg,#a855f7,#6d28d9,#c084fc);border-radius:inherit;box-shadow:0 0 14px #8b5cf666;transition:width .08s linear}
.nx-race-keys{margin-left:auto;display:flex;align-items:center;gap:7px;color:#fff;opacity:.95}
.nx-race-key{min-width:34px;height:34px;display:grid;place-items:center;border-radius:10px;border:1px solid #ffffff28;background:#111318d9;box-shadow:inset 0 1px #fff2,0 5px 16px #0004;font-size:12px;font-weight:900}
.nx-race-key.wide{min-width:58px}
.nx-race-mobile-controls{display:none}
.nx-race-result{position:absolute;inset:0;display:grid;place-items:center;background:#090b0f7a;backdrop-filter:blur(6px);z-index:30}
.nx-race-result-card{width:min(370px,86vw);padding:26px;border-radius:24px;border:1px solid #ffffff20;background:#101217ed;box-shadow:0 30px 90px #000a;color:#fff;text-align:center}
.nx-race-result-card h2{margin:0 0 7px;font-size:30px}
.nx-race-result-card p{margin:0;color:#aaaebb}
.nx-race-result-card .actions{display:flex;gap:10px;justify-content:center;margin-top:18px}
.nx-race-dpad-note{font-size:10px;color:#d7dae2;margin-top:7px}
.nx-race-item{position:absolute;width:34px;height:34px;display:grid;place-items:center;z-index:6;pointer-events:none;transform-origin:center}
.nx-race-item-icon{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;font-size:17px;border:2px solid #0e1013;box-shadow:0 7px 14px #0008,inset 0 1px #fff3}
.nx-race-item.obstacle .nx-race-item-icon{background:linear-gradient(180deg,#ff6b6b,#9e1c29)}
.nx-race-item.boost .nx-race-item-icon{background:linear-gradient(180deg,#b9ff72,#2e8a35);box-shadow:0 0 18px #62e35b66,0 7px 14px #0008,inset 0 1px #fff5}
.nx-race-lap-pill{position:absolute;left:50%;bottom:7%;transform:translateX(-50%) translateY(6px);padding:7px 12px;border-radius:999px;background:#0d1014df;border:1px solid #ffffff1f;color:#fff;font-size:11px;font-weight:900;letter-spacing:.04em;opacity:0;transition:.2s;z-index:11;box-shadow:0 8px 18px #0006}
.nx-race-lap-pill.visible{opacity:1;transform:translateX(-50%)}
.nx-race-checkpoint{position:absolute;left:50%;bottom:12.5%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:999px;background:#101318bf;border:1px solid #ffffff1c;color:#dfe4ec;font-size:10px;font-weight:800;z-index:11;backdrop-filter:blur(10px)}
.nx-race-checkpoint b{color:#b879ff}
.nx-race-effect{position:absolute;left:50%;top:18%;transform:translateX(-50%);padding:10px 15px;border-radius:999px;background:#14171dde;border:1px solid #ffffff22;color:#fff;font-weight:1000;font-size:13px;z-index:15;pointer-events:none;animation:nxRaceEffect .95s ease forwards;text-shadow:0 0 14px #ffffff55}
@keyframes nxRaceEffect{0%{opacity:0;transform:translate(-50%,8px) scale(.82)}18%{opacity:1;transform:translate(-50%,0) scale(1)}78%{opacity:1}100%{opacity:0;transform:translate(-50%,-20px) scale(1.04)}}
.nx-race-laps-overlay{position:absolute;inset:0;display:grid;place-items:center;background:#080b10a8;backdrop-filter:blur(9px);z-index:60;padding:20px}
.nx-race-laps-card{width:min(500px,92vw);padding:34px 30px 28px;border-radius:30px;border:1px solid #ffffff24;background:linear-gradient(145deg,#171a21f4,#0d0f14f4);box-shadow:0 30px 100px #000b;color:#fff;text-align:center}
.nx-race-laps-icon{width:74px;height:74px;margin:0 auto 14px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(145deg,#8b5cf6,#4c1d95);font-size:36px;box-shadow:0 0 35px #7c3aed55}
.nx-race-laps-title{font-size:27px;font-weight:1000;letter-spacing:-.03em}
.nx-race-laps-sub{margin-top:7px;color:#aeb5c3;font-size:13px}
.nx-race-laps-buttons{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:24px}
.nx-race-lap-btn{min-height:112px;border:1px solid #ffffff1d;border-radius:20px;background:linear-gradient(180deg,#1f232b,#101218);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;cursor:pointer;box-shadow:0 12px 28px #0005,inset 0 1px #fff2;transition:.18s}
.nx-race-lap-btn:hover{transform:translateY(-3px);border-color:#9b6cff88;background:linear-gradient(180deg,#2a2140,#11131b);box-shadow:0 15px 35px #0006,0 0 20px #7c3aed22}
.nx-race-lap-btn:active{transform:translateY(0) scale(.98)}
.nx-race-lap-btn strong{font-size:38px;line-height:1;color:#c084fc}
.nx-race-lap-btn span{font-size:12px;font-weight:900;color:#d8dce4}
.nx-race-waiting{margin-top:24px;display:flex;align-items:center;justify-content:center;gap:10px;color:#d9dce5;font-weight:800;padding:14px;border-radius:15px;background:#ffffff08;border:1px solid #ffffff10}

@media(max-width:760px){
  .nx-race-shell{width:100vw;min-height:100dvh;height:100dvh;border-radius:0}
  .nx-race-top{top:10px;left:12px;right:12px}
  .nx-race-stage{margin:66px 7px 132px;min-height:0;width:calc(100% - 14px)}
  .nx-race-hud{left:10px;right:10px;bottom:12px;gap:8px}
  .nx-race-meter{min-width:0;flex:1;padding:8px 10px}
  .nx-race-meter strong{font-size:14px}
  .nx-race-keys{display:none}
  .nx-race-mobile-controls{position:absolute;left:0;right:0;bottom:6px;display:flex;align-items:flex-end;justify-content:space-between;padding:0 12px 8px;z-index:40;pointer-events:none}
  .nx-pedals{display:flex;gap:10px;pointer-events:auto}
  .nx-pedal{width:72px;height:104px;border-radius:20px;border:1px solid #ffffff32;background:linear-gradient(180deg,#20232a,#0e1116);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;font-weight:900;box-shadow:0 14px 30px #0008,inset 0 1px #fff2;touch-action:none;user-select:none;-webkit-user-select:none}
  .nx-pedal:active,.nx-pedal.pressed{transform:translateY(2px) scale(.98);background:linear-gradient(180deg,#2b2f38,#161922)}
  .nx-pedal.gas{border-color:#4a9d4a66}.nx-pedal.brake{border-color:#b53b4b66}
  .nx-pedal-icon{width:34px;height:58px;border-radius:10px;background:linear-gradient(180deg,#40454f,#191c23);border:1px solid #ffffff16;display:grid;place-items:center;font-size:20px}
  .nx-steer-wrap{pointer-events:auto;display:grid;place-items:center}
  .nx-steer-wheel{width:126px;height:126px;border-radius:50%;border:10px solid #24272e;background:radial-gradient(circle at 50% 50%,#15181d 0 25%,#23262d 26% 42%,#101217 43% 100%);box-shadow:0 15px 40px #0009,inset 0 2px #fff2;position:relative;touch-action:none;user-select:none;-webkit-user-select:none}
  .nx-steer-wheel:before{content:"";position:absolute;left:50%;top:14px;bottom:14px;width:9px;transform:translateX(-50%);border-radius:99px;background:#383d46}
  .nx-steer-wheel:after{content:"";position:absolute;top:50%;left:14px;right:14px;height:9px;transform:translateY(-50%);border-radius:99px;background:#383d46}
  .nx-steer-hub{position:absolute;inset:38px;border-radius:50%;background:linear-gradient(180deg,#333842,#15181e);border:1px solid #fff2;display:grid;place-items:center;color:#dce0e8;font-size:18px;font-weight:900;box-shadow:inset 0 2px #fff2}
  .nx-race-finish{top:14.1%;width:20px;height:58px;background-size:10px 10px}
  .nx-race-item{width:27px;height:27px}
  .nx-race-item-icon{width:24px;height:24px;border-radius:8px;font-size:13px}
  .nx-race-checkpoint{bottom:18%;font-size:8px;padding:5px 8px}
  .nx-race-lap-pill{bottom:11%;font-size:9px;padding:5px 9px}
  .nx-race-effect{top:19%;font-size:10px;padding:8px 11px}
  .nx-race-laps-card{padding:26px 18px 20px;border-radius:24px}
  .nx-race-laps-icon{width:62px;height:62px;border-radius:18px;font-size:30px}
  .nx-race-laps-title{font-size:23px}
  .nx-race-laps-sub{font-size:11px}
  .nx-race-laps-buttons{gap:8px;margin-top:18px}
  .nx-race-lap-btn{min-height:88px;border-radius:16px}
  .nx-race-lap-btn strong{font-size:30px}
  .nx-race-lap-btn span{font-size:10px}
  .nx-race-start-light{top:4.2%;padding:5px 8px;gap:4px}
  .nx-race-start-light span{width:8px;height:8px}
  .nx-race-status{top:10.4%;font-size:10px;padding:5px 10px}
  .nx-race-score{padding:7px 9px;font-size:10px}
  .nx-race-score b{font-size:12px}
  .nx-race-car{width:25px;height:46px}
  .nx-race-car .body{inset:3px 4px;border-radius:9px}
  .nx-race-car .hood{left:7px;right:7px;top:4px;height:14px}.nx-race-car .window{left:8px;right:8px;top:15px;height:10px}
  .nx-race-car .wheel{width:5px;top:7px;bottom:7px}.nx-race-car .wheel.left{left:0}.nx-race-car .wheel.right{right:0}
  .nx-race-label{font-size:8px;padding:4px 6px}
}
@media(min-width:761px){
  .nx-race-shell .icon-btn:hover{background:#ffffff14;color:#fff}
}
`;

function getRacePoint(progress, laneOffset = 0) {
  const W = 1000, H = 620
  const left = 100, right = 900, top = 80, bottom = 570, r = 140
  const segments = [
    { len: right-left-2*r, point: t => ({ x:left+r+(right-left-2*r)*t, y:top, tx:1, ty:0 }) },
    { len: Math.PI*r/2, point: t => { const a=-Math.PI/2+(Math.PI/2)*t, cx=right-r, cy=top+r; return {x:cx+r*Math.cos(a),y:cy+r*Math.sin(a),tx:-Math.sin(a),ty:Math.cos(a)} } },
    { len: bottom-top-2*r, point: t => ({ x:right, y:top+r+(bottom-top-2*r)*t, tx:0, ty:1 }) },
    { len: Math.PI*r/2, point: t => { const a=0+(Math.PI/2)*t, cx=right-r, cy=bottom-r; return {x:cx+r*Math.cos(a),y:cy+r*Math.sin(a),tx:-Math.sin(a),ty:Math.cos(a)} } },
    { len: right-left-2*r, point: t => ({ x:right-r-(right-left-2*r)*t, y:bottom, tx:-1, ty:0 }) },
    { len: Math.PI*r/2, point: t => { const a=Math.PI/2+(Math.PI/2)*t, cx=left+r, cy=bottom-r; return {x:cx+r*Math.cos(a),y:cy+r*Math.sin(a),tx:-Math.sin(a),ty:Math.cos(a)} } },
    { len: bottom-top-2*r, point: t => ({ x:left, y:bottom-r-(bottom-top-2*r)*t, tx:0, ty:-1 }) },
    { len: Math.PI*r/2, point: t => { const a=Math.PI+(Math.PI/2)*t, cx=left+r, cy=top+r; return {x:cx+r*Math.cos(a),y:cy+r*Math.sin(a),tx:-Math.sin(a),ty:Math.cos(a)} } }
  ]
  const total = segments.reduce((s,seg)=>s+seg.len,0)
  let d = ((progress % 1) + 1) % 1 * total
  let hit = segments[segments.length-1]
  for (const seg of segments) {
    if (d <= seg.len) { hit = seg; break }
    d -= seg.len
  }
  const base = hit.point(Math.max(0,Math.min(1,d/hit.len || 0)))
  const mag = laneOffset * 34
  const x = base.x + (-base.ty) * mag
  const y = base.y + base.tx * mag
  const rotation = Math.atan2(base.ty,base.tx) * 180 / Math.PI + 90
  return {x,y,rotation}
}


function raceItemsFor(gameKey) {
  let seed = 0
  for (const c of gameKey) seed = (seed * 31 + c.charCodeAt(0)) >>> 0
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }

  const items = []
  const obstacleProgress = [0.14, 0.34, 0.56, 0.78, 0.91]
  const boostProgress = [0.06, 0.24, 0.46, 0.68, 0.84]

  obstacleProgress.forEach((progress, i) => {
    const lanes = [-0.62, 0, 0.62]
    items.push({
      id: `obstacle-${i}`,
      type: 'obstacle',
      progress,
      lane: lanes[Math.floor(rand() * lanes.length)],
      label: '🛑'
    })
  })

  boostProgress.forEach((progress, i) => {
    const lanes = [-0.58, 0, 0.58]
    items.push({
      id: `boost-${i}`,
      type: 'boost',
      progress,
      lane: lanes[Math.floor(rand() * lanes.length)],
      label: '⚡'
    })
  })

  return items
}

function RaceItem({item}) {
  const p = getRacePoint(item.progress, item.lane)
  return <div
    className={cls('nx-race-item', item.type === 'boost' ? 'boost' : 'obstacle')}
    style={{
      left:`${p.x/10}%`,
      top:`${p.y/6.2}%`,
      transform:`translate(-50%,-50%) rotate(${p.rotation}deg)`
    }}
    title={item.type === 'boost' ? 'Ускорение' : 'Препятствие'}
  >
    <div className="nx-race-item-icon">{item.label}</div>
  </div>
}

function RaceCar({progress,lane,color,label,me}) {
  const p = getRacePoint(progress,lane)
  return <>
    <div className={cls('nx-race-car',me?'me':'opp',color)} style={{left:`${p.x/10}%`,top:`${p.y/6.2}%`,transform:`translate(-50%,-50%) rotate(${p.rotation}deg)`}}>
      <div className="body"><div className="hood"/><div className="window"/><div className="wheel left"/><div className="wheel right"/><div className="stripe"/></div>
    </div>
    <div className="nx-race-label" style={{left:`calc(${p.x/10}% + ${me?16:-16}px)`,top:`calc(${p.y/6.2}% - 42px)`,transform:'translate(-50%,-50%)'}}>{label}</div>
  </>
}

function RaceGame({game,session,onClose}) {
  const my=session.user.id
  const other=game.opponent||{}
  const matchIdRef=useRef(game.inviteId||crypto.randomUUID())
  const gameKey=`game-match-${matchIdRef.current}`
  const mineStart=0.015
  const otherStart=0.012
  const isHost=!game.incoming

  const [raceLaps,setRaceLaps]=useState(null)
  const [remoteReady,setRemoteReady]=useState(false)
  const [remoteSettings,setRemoteSettings]=useState(false)
  const [progress,setProgress]=useState(mineStart)
  const [opponentProgress,setOpponentProgress]=useState(otherStart)
  const [lane,setLane]=useState(game.incoming?0.46:-0.46)
  const [opponentLane,setOpponentLane]=useState(game.incoming?-0.46:0.46)
  const [speed,setSpeed]=useState(0)
  const [countdown,setCountdown]=useState(null)
  const [result,setResult]=useState(null)
  const [steerValue,setSteerValue]=useState(0)
  const [gasPressed,setGasPressed]=useState(false)
  const [brakePressed,setBrakePressed]=useState(false)
  const [effectText,setEffectText]=useState('')
  const [effectNonce,setEffectNonce]=useState(0)

  const chRef=useRef(null)
  const physics=useRef({
    progress:mineStart,
    lane:game.incoming?0.46:-0.46,
    speed:0,
    last:performance.now(),
    steer:0,
    boostUntil:0
  })
  const inputRef=useRef({w:false,a:false,s:false,d:false,gas:false,brake:false})
  const resultRef=useRef(null)
  const finishedRef=useRef(false)
  const mountedRef=useRef(true)
  const lastSendRef=useRef(0)
  const readySentRef=useRef(false)
  const remoteReadyRef=useRef(false)
  const remoteSettingsRef=useRef(false)
  const startSentRef=useRef(false)
  const sharedStartAtRef=useRef(null)
  const raceStartedRef=useRef(false)
  const countdownTimerRef=useRef(null)
  const startBroadcastTimerRef=useRef(null)
  const readyHeartbeatTimerRef=useRef(null)
  const raceLapsRef=useRef(null)
  const hitItemsRef=useRef(new Set())
  const items=useRef(raceItemsFor(gameKey)).current

  const publish=payload=>{
    try{
      chRef.current?.send({
        type:'broadcast',
        event:'game',
        payload:{from:my,...payload}
      })
    }catch{}
  }

  const armStartTimer=startAt=>{
    if(!Number.isFinite(startAt) || finishedRef.current)return

    clearInterval(countdownTimerRef.current)

    const tick=()=>{
      if(finishedRef.current){
        clearInterval(countdownTimerRef.current)
        countdownTimerRef.current=null
        return
      }

      const left=startAt-Date.now()
      if(left<=0){
        raceStartedRef.current=true
        setCountdown(0)
        clearInterval(countdownTimerRef.current)
        countdownTimerRef.current=null
        return
      }

      raceStartedRef.current=false
      setCountdown(Math.max(1,Math.ceil(left/1000)))
    }

    tick()
    countdownTimerRef.current=setInterval(tick,80)
  }

  const showEffect=text=>{
    setEffectText(text)
    setEffectNonce(v=>v+1)
  }

  const finish=async(winner)=>{
    if(finishedRef.current)return
    finishedRef.current=true
    raceStartedRef.current=true
    resultRef.current=winner
    setResult(winner)
    setCountdown(null)
    try{
      await supabase.rpc('record_game_match',{
        p_match_key:matchIdRef.current,
        p_game:'racing',
        p_player1_id:my,
        p_player2_id:other.id,
        p_winner_id:winner,
        p_score1:winner===my?1:0,
        p_score2:winner===other.id?1:0,
        p_metadata:{
          track:'Nexly Circuit',
          mode:'topdown-wasd-touch',
          laps:raceLapsRef.current
        }
      })
    }catch{}
    publish({kind:'finish',winnerId:winner})
  }

  useEffect(()=>{
    mountedRef.current=true
    const ch=supabase.channel(gameKey)
      .on('broadcast',{event:'game'},({payload})=>{
        if(!payload||payload.from===my)return

        if(payload.kind==='race-ready'){
          remoteReadyRef.current=true
          setRemoteReady(true)

          // Re-send the authoritative state whenever the guest announces itself.
          // Never resend an old start timestamp after the race is already live.
          if(isHost && raceLapsRef.current && !raceStartedRef.current){
            publish({kind:'race-settings',laps:raceLapsRef.current})
            const startAt=sharedStartAtRef.current
            if(Number.isFinite(startAt) && Date.now()<startAt){
              publish({kind:'race-start',startAt})
            }
          }
        }

        if(payload.kind==='race-sync'){
          const laps=Number(payload.laps)
          if(Number.isFinite(laps) && laps>=1){
            const safe=Math.max(1,Math.min(3,Math.floor(laps)))
            raceLapsRef.current=safe
            setRaceLaps(safe)
            remoteSettingsRef.current=true
            setRemoteSettings(true)
          }

          if(payload.startAt!=null && !raceStartedRef.current){
            const startAt=Number(payload.startAt)
            if(Number.isFinite(startAt)){
              const now=Date.now()
              if(now>=startAt){
                // A late packet belongs to an already-started race. Lock the
                // local state to GO so an old timestamp can never re-arm the timer.
                sharedStartAtRef.current=startAt
                raceStartedRef.current=true
                setCountdown(0)
                clearInterval(countdownTimerRef.current)
                countdownTimerRef.current=null
              }else{
                sharedStartAtRef.current=startAt
                armStartTimer(startAt)
              }
            }
          }
        }

        if(payload.kind==='race-settings'){
          const laps=Math.max(1,Math.min(3,Number(payload.laps)||1))
          raceLapsRef.current=laps
          setRaceLaps(laps)
          remoteSettingsRef.current=true
          setRemoteSettings(true)
          if(!raceStartedRef.current) setCountdown(null)
          if(!isHost){
            publish({kind:'race-settings-ack',laps})
          }
        }

        if(payload.kind==='race-settings-ack'){
          const laps=Math.max(1,Math.min(3,Number(payload.laps)||1))
          if(raceLapsRef.current===laps){
            remoteSettingsRef.current=true
            setRemoteSettings(true)
          }
        }

        if(payload.kind==='race-start'){
          // Once GO has happened, ignore every duplicate/late start packet.
          if(!raceStartedRef.current){
            const startAt=Number(payload.startAt)
            if(Number.isFinite(startAt)){
              const now=Date.now()
              sharedStartAtRef.current=startAt
              if(now>=startAt){
                raceStartedRef.current=true
                setCountdown(0)
                clearInterval(countdownTimerRef.current)
                countdownTimerRef.current=null
              }else{
                armStartTimer(startAt)
              }
            }
          }
        }

        if(payload.kind==='race'){
          const value=Math.max(0,Math.min(1,Number(payload.progress)||0))
          setOpponentProgress(value)
          if(value>=1)finish(other.id)
        }

        if(payload.kind==='race-state'){
          const value=Math.max(0,Math.min(1,Number(payload.progress)||0))
          setOpponentProgress(value)
          setOpponentLane(Number(payload.lane)||0)
        }

        if(payload.kind==='finish'){
          resultRef.current=payload.winnerId
          setResult(payload.winnerId)
          setCountdown(null)
        }
      })
      .subscribe(status=>{
        if(status==='SUBSCRIBED'){
          chRef.current=ch

          if(!readySentRef.current){
            readySentRef.current=true
            publish({kind:'race-ready'})
          }

          // Broadcast messages are ephemeral. Keep announcing readiness for a few
          // seconds so a player who subscribes slightly later still joins the handshake.
          clearInterval(readyHeartbeatTimerRef.current)
          readyHeartbeatTimerRef.current=setInterval(()=>{
            if(finishedRef.current || raceStartedRef.current)return
            publish({kind:'race-ready'})

            if(isHost && raceLapsRef.current){
              const startAt=sharedStartAtRef.current
              const startStillPending=Number.isFinite(startAt) && Date.now()<startAt
              publish({
                kind:'race-sync',
                laps:raceLapsRef.current,
                startAt:startStillPending?startAt:null
              })
            }
          },500)
        }
      })

    return()=>{
      mountedRef.current=false
      clearInterval(readyHeartbeatTimerRef.current)
      clearInterval(startBroadcastTimerRef.current)
      clearInterval(countdownTimerRef.current)
      readyHeartbeatTimerRef.current=null
      startBroadcastTimerRef.current=null
      countdownTimerRef.current=null
      supabase.removeChannel(ch)
    }
  },[gameKey,other.id])

  // Host chooses 1/2/3 laps. The choice is authoritative for both players.
  const chooseLaps=laps=>{
    if(!isHost||finishedRef.current)return

    const safe=Math.max(1,Math.min(3,Number(laps)||1))
    raceLapsRef.current=safe
    remoteSettingsRef.current=false
    startSentRef.current=false
    raceStartedRef.current=false
    sharedStartAtRef.current=null
    clearInterval(countdownTimerRef.current)
    countdownTimerRef.current=null
    clearInterval(startBroadcastTimerRef.current)
    startBroadcastTimerRef.current=null

    setRaceLaps(safe)
    setRemoteSettings(false)
    setCountdown(null)

    // Send the setting several times because Supabase Broadcast is not a durable queue.
    const sendSettings=()=>{
      if(finishedRef.current || raceLapsRef.current!==safe)return
      publish({kind:'race-settings',laps:safe})
      publish({kind:'race-sync',laps:safe,startAt:sharedStartAtRef.current||null})
    }

    sendSettings()
    setTimeout(sendSettings,300)
    setTimeout(sendSettings,800)
    setTimeout(sendSettings,1500)
  }

  // The host can start as soon as the lap choice exists. The guest only starts
  // locally after it has received the authoritative settings/start state.
  const canStart=Boolean(
    raceLaps &&
    chRef.current?.state==='joined' &&
    (isHost || remoteSettings)
  )

  // Only the host owns the race clock. A future timestamp is broadcast repeatedly
  // so a guest that subscribes a little later can still synchronize with the same start.
  useEffect(()=>{
    if(!canStart||result!==null||!isHost||startSentRef.current)return

    startSentRef.current=true
    raceStartedRef.current=false
    const startAt=Date.now()+7000
    sharedStartAtRef.current=startAt
    armStartTimer(startAt)

    const sendStart=()=>{
      if(finishedRef.current)return
      publish({kind:'race-start',startAt})
      publish({
        kind:'race-sync',
        laps:raceLapsRef.current,
        startAt
      })
    }

    sendStart()
    clearInterval(startBroadcastTimerRef.current)
    startBroadcastTimerRef.current=setInterval(()=>{
      if(Date.now()>=startAt+500 || finishedRef.current){
        clearInterval(startBroadcastTimerRef.current)
        startBroadcastTimerRef.current=null
        return
      }
      sendStart()
    },500)
  },[canStart,result,isHost])

  useEffect(()=>()=>{
    clearInterval(countdownTimerRef.current)
    countdownTimerRef.current=null
  },[])

  const getOtherProgressRef = useRef(otherStart)
  getOtherProgressRef.current=opponentProgress

  useEffect(()=>{
    if(!canStart||countdown===null||countdown>0||result!==null)return

    // The physics loop itself is the final source of truth for GO. Once it
    // starts, late handshake packets can no longer return the UI to preparation.
    raceStartedRef.current=true

    let raf=0
    const frame=now=>{
      const p=physics.current
      const dt=Math.min(.035,Math.max(.008,(now-p.last)/1000))
      p.last=now

      const keys=inputRef.current
      const steer=keys.a?-1:keys.d?1:p.steer
      const gas=keys.w||keys.gas
      const brake=keys.s||keys.brake
      const boostActive=p.boostUntil>now

      const speedCap=boostActive?1.68:1.25
      if(gas)p.speed=Math.min(speedCap,p.speed+dt*.82)
      else p.speed=Math.max(0,p.speed-dt*.20)
      if(brake)p.speed=Math.max(0,p.speed-dt*1.85)

      const steeringPower=.15+p.speed*.82
      p.lane=Math.max(-.86,Math.min(.86,p.lane+steer*dt*steeringPower*.42))

      if(Math.abs(steer)<.02 && !(keys.a||keys.d))p.lane*=.997

      p.progress=Math.min(1,p.progress+p.speed*dt*.037)

      // Obstacles / boosts are deterministic for both players.
      const lapsCount=raceLapsRef.current||1
      const lap=Math.min(lapsCount-1,Math.floor(p.progress*lapsCount))
      const lapPos=(p.progress*lapsCount)%1

      for(const item of items){
        const distance=Math.min(
          Math.abs(lapPos-item.progress),
          1-Math.abs(lapPos-item.progress)
        )
        if(distance<.018 && Math.abs(p.lane-item.lane)<.23){
          const hitKey=`${lap}-${item.id}`
          if(!hitItemsRef.current.has(hitKey)){
            hitItemsRef.current.add(hitKey)

            if(item.type==='boost'){
              p.boostUntil=now+1700
              p.speed=Math.min(1.68,p.speed+.55)
              showEffect('⚡ УСКОРЕНИЕ!')
            }else{
              p.speed*=.38
              p.lane+=p.lane>=item.lane?.12:-.12
              p.lane=Math.max(-.86,Math.min(.86,p.lane))
              showEffect('💥 ПРЕПЯТСТВИЕ!')
            }
          }
        }
      }

      physics.current=p
      setProgress(p.progress)
      setLane(p.lane)
      setSpeed(p.speed)

      if(now-lastSendRef.current>55){
        lastSendRef.current=now
        publish({
          kind:'race-state',
          progress:p.progress,
          lane:p.lane,
          speed:p.speed
        })
      }

      if(p.progress>=1){
        finish(my)
        return
      }

      raf=requestAnimationFrame(frame)
    }

    raf=requestAnimationFrame(frame)
    return()=>cancelAnimationFrame(raf)
  },[canStart,countdown,result,items])

  useEffect(()=>{
    const down=e=>{
      if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement)return
      const k=e.key.toLowerCase()
      if(['w','a','s','d'].includes(k)){
        e.preventDefault()
        inputRef.current[k]=true
      }
    }
    const up=e=>{
      const k=e.key.toLowerCase()
      if(['w','a','s','d'].includes(k)){
        e.preventDefault()
        inputRef.current[k]=false
      }
    }
    window.addEventListener('keydown',down,{passive:false})
    window.addEventListener('keyup',up,{passive:false})
    return()=>{
      window.removeEventListener('keydown',down)
      window.removeEventListener('keyup',up)
    }
  },[])

  useEffect(()=>{inputRef.current.gas=gasPressed},[gasPressed])
  useEffect(()=>{inputRef.current.brake=brakePressed},[brakePressed])

  const setSteerFromPointer=(e,el)=>{
    if(!el)return
    const r=el.getBoundingClientRect()
    const dx=e.clientX-(r.left+r.width/2)
    const norm=Math.max(-1,Math.min(1,dx/(r.width*.42)))
    physics.current.steer=norm
    setSteerValue(norm)
  }

  const beginWheel=e=>{
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setSteerFromPointer(e,e.currentTarget)
  }
  const moveWheel=e=>{
    if(e.currentTarget.hasPointerCapture?.(e.pointerId))setSteerFromPointer(e,e.currentTarget)
  }
  const endWheel=e=>{
    try{e.currentTarget.releasePointerCapture?.(e.pointerId)}catch{}
    physics.current.steer=0
    setSteerValue(0)
  }

  const pedal=(name,val,setter)=>e=>{
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setter(val)
  }

  const restart=()=>window.location.reload()

  const totalLaps=raceLaps||1
  const lapNumber=Math.min(totalLaps,Math.floor(progress*totalLaps)+1)
  const minePct=Math.min(100,Math.round(progress*100))
  const oppPct=Math.min(100,Math.round(opponentProgress*100))
  const lapProgress=Math.round(((progress*totalLaps)%1)*100)
  const oppLapNumber=Math.min(totalLaps,Math.floor(opponentProgress*totalLaps)+1)
  const mph=Math.round(speed*190)
  const rp=getRacePoint(progress*totalLaps,lane)
  const opp=getRacePoint(opponentProgress*totalLaps,opponentLane)
  const readyText=!raceLaps
    ? (isHost?'Выбери количество кругов':'Соперник выбирает количество кругов…')
    : (!remoteSettings
      ? 'Ожидание подтверждения…'
      : countdown===null
        ? 'Подготовка старта…'
        : countdown>0
          ? `СТАРТ ЧЕРЕЗ ${countdown}`
          : 'ГОНИ!')

  return <div className="modal-backdrop">
    <style>{RACE_CSS}</style>
    <div className="nx-race-shell">

      <div className="nx-race-top">
        <div className="nx-race-score">
          <span className="dot"/>
          <span>🏎️ Nexly Racing</span>
          <b>{minePct}:{oppPct}</b>
        </div>
        <button className="icon-btn nx-race-close" onClick={onClose} title="Закрыть"><I.X/></button>
      </div>

      {raceLaps===null&&<div className="nx-race-laps-overlay">
        <div className="nx-race-laps-card">
          <div className="nx-race-laps-icon">🏁</div>
          <div className="nx-race-laps-title">Выбери дистанцию</div>
          <div className="nx-race-laps-sub">
            {isHost
              ? 'Сколько кругов продержится гонка?'
              : 'Соперник выбирает количество кругов'}
          </div>

          {isHost
            ? <div className="nx-race-laps-buttons">
                {[1,2,3].map(n=><button
                  key={n}
                  className="nx-race-lap-btn"
                  onClick={()=>chooseLaps(n)}
                >
                  <strong>{n}</strong>
                  <span>{n===1?'Круг':n<5?'Круга':'Кругов'}</span>
                </button>)}
              </div>
            : <div className="nx-race-waiting">
                <span className="spinner small"/>
                Ожидание выбора…
              </div>
          }
        </div>
      </div>}

      <div className="nx-race-stage">
        <svg className="nx-race-track" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={`road-${matchIdRef.current}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2f343a"/>
              <stop offset="1" stopColor="#181b1f"/>
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="1000" height="620" fill="none"/>
          <path d="M 240 80 H 760 A 140 140 0 0 1 900 220 V 430 A 140 140 0 0 1 760 570 H 240 A 140 140 0 0 1 100 430 V 220 A 140 140 0 0 1 240 80 Z" fill="none" stroke="#ffffff22" strokeWidth="54"/>
          <path d="M 240 80 H 760 A 140 140 0 0 1 900 220 V 430 A 140 140 0 0 1 760 570 H 240 A 140 140 0 0 1 100 430 V 220 A 140 140 0 0 1 240 80 Z" fill="none" stroke={`url(#road-${matchIdRef.current})`} strokeWidth="48"/>
          <path d="M 240 80 H 760 A 140 140 0 0 1 900 220 V 430 A 140 140 0 0 1 760 570 H 240 A 140 140 0 0 1 100 430 V 220 A 140 140 0 0 1 240 80 Z" fill="none" stroke="#e9edf2b8" strokeWidth="2.5"/>
          <path d="M 240 80 H 760 A 140 140 0 0 1 900 220 V 430 A 140 140 0 0 1 760 570 H 240 A 140 140 0 0 1 100 430 V 220 A 140 140 0 0 1 240 80 Z" fill="none" stroke="#090b0d" strokeWidth="38" strokeDasharray="18 22" opacity=".7"/>
        </svg>

        {items.map(item=><RaceItem key={item.id} item={item}/>)}

        <div className="nx-race-finish"/>
        <div className={cls('nx-race-start-light',countdown===0&&'go')}>
          {[0,1,2,3].map(i=><span key={i}/>)}
        </div>
        <div className="nx-race-status">
          {readyText}
        </div>

        {effectText&&<div key={effectNonce} className="nx-race-effect">{effectText}</div>}

        <div className={cls('nx-race-lap-pill',raceLaps&&'visible')}>
          {raceLaps ? <>КРУГ <b>{lapNumber}</b> / {totalLaps}</> : 'КРУГ —'}
        </div>

        <div
          className="nx-race-car me red"
          style={{
            left:`${rp.x/10}%`,
            top:`${rp.y/6.2}%`,
            transform:`translate(-50%,-50%) rotate(${rp.rotation}deg)`
          }}
        >
          <div className="body"><div className="hood"/><div className="window"/><div className="wheel left"/><div className="wheel right"/><div className="stripe"/></div>
        </div>
        <div
          className="nx-race-label"
          style={{left:`calc(${rp.x/10}% + 16px)`,top:`calc(${rp.y/6.2}% - 42px)`,transform:'translate(-50%,-50%)'}}
        >
          Ты · {minePct}%
        </div>

        <div
          className="nx-race-car opp blue"
          style={{
            left:`${opp.x/10}%`,
            top:`${opp.y/6.2}%`,
            transform:`translate(-50%,-50%) rotate(${opp.rotation}deg)`
          }}
        >
          <div className="body"><div className="hood"/><div className="window"/><div className="wheel left"/><div className="wheel right"/><div className="stripe"/></div>
        </div>
        <div
          className="nx-race-label"
          style={{left:`calc(${opp.x/10}% - 16px)`,top:`calc(${opp.y/6.2}% - 42px)`,transform:'translate(-50%,-50%)'}}
        >
          @{other.username||'соперник'} · {oppPct}%
        </div>

        <div className="nx-race-checkpoint">
          <span>Круг {lapNumber}/{totalLaps}</span>
          <b>{lapProgress}%</b>
        </div>
      </div>

      <div className="nx-race-hud">
        <div className="nx-race-meter">
          <div className="nx-race-meter-row"><span>Скорость</span><strong>{mph} км/ч</strong></div>
          <div className="nx-race-bar"><span style={{width:`${Math.min(100,Math.round((speed/1.68)*100))}%`}}/></div>
          <div className="nx-race-meter-row" style={{marginTop:7}}>
            <span>Ты · круг {lapNumber}</span><span>{minePct}%</span>
          </div>
          <div className="nx-race-meter-row">
            <span>@{other.username||'соперник'} · круг {oppLapNumber}</span><span>{oppPct}%</span>
          </div>
          <div className="nx-race-dpad-note">ПК: W — газ · S — тормоз · A/D — руль</div>
        </div>

        <div className="nx-race-keys" aria-label="Клавиши управления">
          <span className="nx-race-key">A</span>
          <span className="nx-race-key">W</span>
          <span className="nx-race-key">D</span>
          <span className="nx-race-key wide">S</span>
        </div>
      </div>

      <div className="nx-race-mobile-controls">
        <div className="nx-pedals">
          <button className={cls('nx-pedal brake',brakePressed&&'pressed')} onPointerDown={pedal('brake',true,setBrakePressed)} onPointerUp={pedal('brake',false,setBrakePressed)} onPointerCancel={pedal('brake',false,setBrakePressed)}><span className="nx-pedal-icon">▼</span><span>ТОРМОЗ</span></button>
          <button className={cls('nx-pedal gas',gasPressed&&'pressed')} onPointerDown={pedal('gas',true,setGasPressed)} onPointerUp={pedal('gas',false,setGasPressed)} onPointerCancel={pedal('gas',false,setGasPressed)}><span className="nx-pedal-icon">▲</span><span>ГАЗ</span></button>
        </div>

        <div className="nx-steer-wrap">
          <div
            className="nx-steer-wheel"
            onPointerDown={beginWheel}
            onPointerMove={moveWheel}
            onPointerUp={endWheel}
            onPointerCancel={endWheel}
            aria-label="Руль"
          >
            <div className="nx-steer-hub" style={{transform:`rotate(${steerValue*55}deg)`}}>↔</div>
          </div>
        </div>
      </div>

      {result!==null&&<div className="nx-race-result">
        <div className="nx-race-result-card">
          <h2>{result===my?'Победа! 🏆':'Финиш 🏁'}</h2>
          <p>{result===my
            ? `Ты первым прошёл ${totalLaps} ${totalLaps===1?'круг':'круга'}!`
            : `Соперник первым прошёл ${totalLaps} ${totalLaps===1?'круг':'круга'}.`
          }</p>
          <div className="actions">
            <button className="outline" onClick={onClose}>Закрыть</button>
            <button className="primary" onClick={restart}>Играть снова</button>
          </div>
        </div>
      </div>}
    </div>
  </div>
}

function GameModal({ game, session, onClose }) {
  const idRef=useRef(game.inviteId||crypto.randomUUID()), gameKey=`game-match-${idRef.current}`, my=session.user.id, other=game.opponent
  const [result,setResult]=useState(null),[mine,setMine]=useState(null),[theirs,setTheirs]=useState(null),[board,setBoard]=useState(Array(9).fill('')), [turn,setTurn]=useState(game.incoming?other.id:my),[rpsRound,setRpsRound]=useState(1),[scoreMine,setScoreMine]=useState(0),[scoreOther,setScoreOther]=useState(0)
  const chRef=useRef(null),finished=useRef(false)
  const track = GAME_TRACKS[(gameKey.split('').reduce((a,c)=>a+c.charCodeAt(0),0)) % GAME_TRACKS.length]
  useEffect(()=>{const ch=supabase.channel(gameKey).on('broadcast',{event:'game'},({payload})=>{if(!payload||payload.from===my)return;if(payload.kind==='rps'){setTheirs(payload.choice)}if(payload.kind==='rps-reset'){setMine(null);setTheirs(null);setRpsRound(payload.round)}if(payload.kind==='ttt'){setBoard(payload.board);setTurn(payload.turn);if(payload.result!==undefined)setResult(payload.result)}if(payload.kind==='finish'){setResult(payload.winnerId)}}).subscribe(st=>{if(st==='SUBSCRIBED'){chRef.current=ch}});return()=>supabase.removeChannel(ch)},[gameKey])
  const send=p=>chRef.current?.send({type:'broadcast',event:'game',payload:{from:my,...p}})
  const finish=async winner=>{if(finished.current)return;finished.current=true;setResult(winner);try{await supabase.rpc('record_game_match',{p_match_key:idRef.current,p_game:game.game,p_player1_id:my,p_player2_id:other.id,p_winner_id:winner,p_score1:winner===my?1:0,p_score2:winner===other.id?1:0,p_metadata:{rpsRound,track}})}catch{}send({kind:'finish',winnerId:winner})}
  useEffect(()=>{if(mine&&theirs&&!result&&game.game==='rps'){const beats={rock:'scissors',scissors:'paper',paper:'rock'};const w=mine===theirs?null:(beats[mine]===theirs?my:other.id);if(w===my)setScoreMine(s=>s+1);if(w===other.id)setScoreOther(s=>s+1);const nm=scoreMine+(w===my?1:0),no=scoreOther+(w===other.id?1:0);setTimeout(()=>{if(nm>=2)finish(my);else if(no>=2)finish(other.id);else{setRpsRound(r=>r+1);send({kind:'rps-reset',round:rpsRound+1});setMine(null);setTheirs(null)}},400)}},[mine,theirs])
  const playRps=c=>{if(!mine&&!result)setMine(c),send({kind:'rps',choice:c})}
  const move=i=>{if(board[i]||turn!==my||result)return;const next=[...board];next[i]=game.incoming?'O':'X';const win=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].find(([a,b,c])=>next[a]&&next[a]===next[b]&&next[a]===next[c]);const nextTurn=win?null:(game.incoming?my:other.id);setBoard(next);setTurn(nextTurn);send({kind:'ttt',board:next,turn:nextTurn,result:win?my:(next.every(Boolean)?null:undefined)});if(win)finish(my);else if(next.every(Boolean))finish(null)}
  if(game.game==='racing') return <RaceGame game={game} session={session} onClose={onClose}/>
  return <div className="modal-backdrop"><div className="modal game-modal"><div className="modal-head"><div><h3>{GAME_META[game.game].icon} {GAME_META[game.game].label}</h3><div className="muted">Против: @{other.username}</div></div><button className="icon-btn" onClick={onClose}><I.X/></button></div>{game.game==='rps'&&<div className="game-content"><div className="game-score"><span>Раунд {rpsRound} · ты {scoreMine}:{scoreOther} соперник</span></div><div className="rps-buttons"><button onClick={()=>playRps('rock')}>✊</button><button onClick={()=>playRps('scissors')}>✌️</button><button onClick={()=>playRps('paper')}>✋</button></div>{result!==null&&<GameResult result={result} myId={my} onClose={onClose} onReplay={()=>window.location.reload()}/>}</div>}{game.game==='tictactoe'&&<div className="game-content"><div className="game-status">{result?'Матч завершён':turn===my?'Твой ход':'Ход соперника'}</div><div className="ttt-board">{board.map((v,i)=><button key={i} onClick={()=>move(i)}>{v}</button>)}</div>{result!==null&&<GameResult result={result} myId={my} onClose={onClose} onReplay={()=>window.location.reload()}/>}</div>}</div></div>
}
function GameResult({result,myId,onClose,onReplay}){return <div className="game-result"><h3>{result===null?'Ничья':result===myId?'Победа! 🎉':'Поражение'}</h3><div className="muted">Результат сохранён.</div><div className="game-result-actions"><button className="outline" onClick={onClose}>Закрыть</button><button className="primary" onClick={onReplay}>Играть снова</button></div></div>}

function notifyIncoming(title, body) {
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body }) } catch {}
}

let incomingCallAudio = null
function playIncomingCallTone() { try { incomingCallAudio?.pause(); incomingCallAudio=new Audio('/sounds/iphone_x.mp3'); incomingCallAudio.loop=true; incomingCallAudio.volume=.85; incomingCallAudio.play().catch(()=>{}) } catch {} }
function stopIncomingCallTone() { try { incomingCallAudio?.pause(); if (incomingCallAudio) incomingCallAudio.currentTime=0 } catch {} }

let audioCtx
function playPing() {
  try {
    audioCtx = audioCtx || new AudioContext()
    const o = audioCtx.createOscillator(), g = audioCtx.createGain()
    o.frequency.value = 880
    g.gain.value = .05
    o.connect(g)
    g.connect(audioCtx.destination)
    o.start()
    o.stop(audioCtx.currentTime + .12)
  } catch {}
}
