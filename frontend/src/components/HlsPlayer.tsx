import Hls from 'hls.js'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { WifiOff, Loader } from 'lucide-react'

type Status = 'loading' | 'playing' | 'error'

export interface HlsPlayerHandle {
  setMuted: (muted: boolean) => void
}

interface Props {
  src: string
  startMuted?: boolean
  className?: string
  objectFit?: 'cover' | 'contain'
  showLoader?: boolean
}

const HlsPlayer = forwardRef<HlsPlayerHandle, Props>(function HlsPlayer(
  { src, startMuted = true, className = '', objectFit = 'contain', showLoader = true },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  // Expose setMuted so parent can call it directly inside a click handler
  // (must be synchronous / within user-gesture context for Brave / strict autoplay policies)
  useImperativeHandle(ref, () => ({
    setMuted: (muted: boolean) => {
      if (videoRef.current) videoRef.current.muted = muted
    },
  }))

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
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 10,
        backBufferLength: 30,
      })
      hlsRef.current = hls

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().then(() => {
          // Apply caller's requested initial mute state after play succeeds.
          // Note: for browser autoplay policies (e.g. Brave), this may be
          // silently ignored if there has been no prior user gesture on the page.
          // The parent should use the HlsPlayerHandle.setMuted() method inside
          // a click handler for reliable unmuting.
          if (!startMuted) video.muted = false
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
          if (!startMuted) video.muted = false
          setStatus('playing')
        }).catch(() => setStatus('playing'))
      })
      video.addEventListener('error', () => setStatus('error'))
    } else {
      setStatus('error')
    }

    return destroy
  }, [src, startMuted])

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
