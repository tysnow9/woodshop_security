import Hls from 'hls.js'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { WifiOff, Loader } from 'lucide-react'

type Status = 'loading' | 'playing' | 'error'

export interface HlsPlayerHandle {
  setMuted: (muted: boolean) => void
  pause: () => void
  resume: () => void
}

interface Props {
  src: string
  startMuted?: boolean
  className?: string
  objectFit?: 'cover' | 'contain'
  showLoader?: boolean
  onMuteBlocked?: () => void
}

const HlsPlayer = forwardRef<HlsPlayerHandle, Props>(function HlsPlayer(
  { src, startMuted = true, className = '', objectFit = 'contain', showLoader = true, onMuteBlocked },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  useImperativeHandle(ref, () => ({
    setMuted: (muted: boolean) => {
      if (videoRef.current) videoRef.current.muted = muted
    },
    pause: () => {
      hlsRef.current?.stopLoad()
      videoRef.current?.pause()
    },
    resume: () => {
      if (hlsRef.current) hlsRef.current.startLoad(-1)
      videoRef.current?.play().catch(() => {})
    },
  }))

  // Capture startMuted at mount time only — changes to it should not rebuild the player.
  // Mute toggling after mount goes through setMuted() via the ref handle.
  const startMutedRef = useRef(startMuted)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setStatus('loading')
    video.muted = true // always start muted so autoplay is allowed

    function destroy() {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        // 2 segments of buffer before playback starts. For the main stream
        // (3s segments) this gives ~9s total latency but prevents the stall
        // that occurs when the first segment ends before the next is ready.
        // For the thumb stream (1s segments) the impact is negligible.
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 10,
        backBufferLength: 0,
      })
      hlsRef.current = hls

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().then(() => {
          if (!startMutedRef.current) {
            video.muted = false
            // If the browser blocked the unmute (no prior user gesture), notify
            // the parent so it can sync its muted state back to true — otherwise
            // the button label is wrong and the user has to click twice.
            if (video.muted) onMuteBlocked?.()
          }
          setStatus('playing')
        }).catch(() => {
          // Autoplay blocked entirely — still show as playing (video will be paused)
          setStatus('playing')
        })
      })

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setStatus('error')
      })

      hls.loadSource(src)
      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      video.addEventListener('loadedmetadata', () => {
        video.play().then(() => {
          if (!startMutedRef.current) video.muted = false
          setStatus('playing')
        }).catch(() => setStatus('playing'))
      })
      video.addEventListener('error', () => setStatus('error'))
    } else {
      setStatus('error')
    }

    return destroy
  }, [src])

  return (
    <div className={`relative bg-black ${className}`}>
      <video
        ref={videoRef}
        playsInline
        className={`w-full h-full ${objectFit === 'cover' ? 'object-cover' : 'object-contain'}`}
      />

      {showLoader && status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950">
          <Loader size={20} className="text-zinc-600 animate-spin" />
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950">
          <WifiOff size={22} className="text-zinc-600" />
          <span className="text-xs text-zinc-600">Stream unavailable</span>
        </div>
      )}
    </div>
  )
})

export default HlsPlayer
