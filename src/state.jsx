import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase, usernameEmail } from './supabase'

const AuthContext = createContext(null)

function normalizeUsername(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase()
}

function validateUsername(username) {
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) {
    throw new Error('ID должен содержать 3–24 символа: a-z, 0-9, _, ., -')
  }
}

async function loadUserProfile(userId) {
  if (!userId) return null
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (error) throw error
  return data || null
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshProfile = async (userId = session?.user?.id) => {
    if (!userId) {
      setProfile(null)
      return null
    }
    const data = await loadUserProfile(userId)
    setProfile(data)
    return data
  }

  useEffect(() => {
    let active = true

    const boot = async () => {
      try {
        const { data, error: sessionError } = await supabase.auth.getSession()
        if (!active) return
        if (sessionError) throw sessionError

        setSession(data.session)
        if (data.session?.user) {
          try {
            const p = await loadUserProfile(data.session.user.id)
            if (active) setProfile(p)
          } catch (e) {
            if (active) setError(e.message || 'Не удалось загрузить профиль')
          }
        }
      } catch (e) {
        if (active) {
          setError(e.message || 'Ошибка авторизации')
          setSession(null)
          setProfile(null)
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    boot()

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      if (!nextSession?.user) {
        setProfile(null)
        return
      }
      setTimeout(async () => {
        if (!active) return
        try {
          const p = await loadUserProfile(nextSession.user.id)
          if (active) setProfile(p)
        } catch (e) {
          if (active) setError(e.message || 'Не удалось загрузить профиль')
        }
      }, 0)
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({
    session,
    profile,
    loading,
    error,
    setError,
    refreshProfile: () => refreshProfile(),

    register: async ({ username, password, displayName, phone }) => {
      setError('')
      const clean = normalizeUsername(username)
      validateUsername(clean)
      if (!password || password.length < 6) throw new Error('Пароль должен содержать минимум 6 символов')

      const technicalEmail = usernameEmail(clean)
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: technicalEmail,
        password,
        options: {
          data: {
            username: clean,
            display_name: String(displayName || '').trim() || clean,
            phone: String(phone || '').trim() || null
          }
        }
      })
      if (signUpError) throw signUpError
      if (!data?.session || !data?.user) {
        throw new Error('Регистрация создана, но сессия не выдана. В Supabase отключите Confirm Email.')
      }

      setSession(data.session)
      const now = new Date().toISOString()
      const profilePayload = {
        id: data.user.id,
        username: clean,
        display_name: String(displayName || '').trim() || clean,
        phone: String(phone || '').trim() || null,
        email_verified_at: now,
        updated_at: now
      }

      const { error: profileError } = await supabase.from('profiles').upsert(profilePayload, { onConflict: 'id' })
      if (profileError) console.warn('Profile upsert:', profileError.message)
      try { await refreshProfile(data.user.id) } catch (e) { console.warn('Profile reload:', e.message) }
      return data
    },

    login: async ({ username, password }) => {
      setError('')
      const clean = normalizeUsername(username)
      validateUsername(clean)
      if (!password) throw new Error('Введите пароль')

      const { data, error: loginError } = await supabase.auth.signInWithPassword({
        email: usernameEmail(clean),
        password
      })
      if (loginError) {
        if (loginError.message === 'Invalid login credentials') throw new Error('Неверный ID или пароль')
        throw loginError
      }
      if (!data?.session) throw new Error('Supabase не вернул сессию')
      setSession(data.session)
      try { await refreshProfile(data.user.id) } catch (e) { console.warn('Profile reload:', e.message) }
      return data
    },

    logout: async () => {
      setError('')
      const { error: logoutError } = await supabase.auth.signOut()
      if (logoutError) throw logoutError
      setSession(null)
      setProfile(null)
    }
  }), [session, profile, loading, error])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
