import { useParams } from 'react-router-dom'

const APP_STORE_URL = 'https://apps.apple.com/in/app/jbmr-sports/id6808138064'
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=in.jbmrsports.ott'

export function MatchSharePage() {
  const { id } = useParams()
  const canOpen = id && /^[a-zA-Z0-9_:-]{1,160}$/.test(id)

  return (
    <section className="web-fig-section web-download-section">
      <div className="web-download-card">
        <div className="web-download-copy">
          <h1>{canOpen ? 'Open the match' : 'Invalid match link'}</h1>
          <div className="web-hero-v2-actions">
            {canOpen && (
              <a className="web-btn-cta" href={`jbmrsports://match/${id}`}>
                Open in JBMR Sports
              </a>
            )}
            <a className="web-btn-ghost" href="/#download">Download the app</a>
          </div>
        </div>
        <img className="web-download-icon" src="/app-icon.png" alt="" width={160} height={160} />
      </div>
    </section>
  )
}

export function HomePage() {
  const features = [
    {
      image: '/home-art/live.webp',
      title: 'Live matches & scorecards',
      body: 'Watch live matches in the app, follow runs and wickets as they happen, and open the full scorecard for batting and bowling figures.',
    },
    {
      image: '/home-art/clips.webp',
      title: 'Ball-by-ball video & Shorts',
      body: 'Replay deliveries when ball-by-ball video is available. Watch and share Shorts from the app.',
    },
    {
      image: '/home-art/performance.webp',
      title: 'My Performance',
      body: 'Link your player profile to see your batting and bowling stats in My Performance.',
    },
  ]

  return (
    <div className="sports-home">
      <section className="sports-home-hero">
        <div className="sports-home-art" aria-hidden="true">
          <img src="/home-art/cricket-hero.webp" alt="" fetchPriority="high" />
        </div>
        <div className="sports-home-width sports-home-hero-inner">
          <div className="sports-home-hero-copy">
            <h1>Cricket.<br /><span>Ball by ball.</span></h1>
            <p>Watch live matches, follow every run and wicket, and revisit the action in the JBMR Sports app.</p>
            <div className="sports-home-actions">
              <a className="sports-home-button sports-home-primary" href="#download">Get the app <span aria-hidden="true">↓</span></a>
              <a className="sports-home-button" href="#features">Explore features</a>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="sports-home-width sports-home-section" aria-labelledby="sports-home-features">
        <h2 id="sports-home-features">Inside the app</h2>
        <div className="sports-home-features">
          {features.map(({ image, title, body }) => (
            <article key={title} className="sports-home-feature">
              <img src={image} alt="" loading="lazy" />
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="how" className="sports-home-width sports-home-section sports-home-how" aria-labelledby="sports-home-how">
        <h2 id="sports-home-how">How to watch</h2>
        <ol>
          <li><h3>Install JBMR Sports</h3><p>Get the app from the App Store or Google Play.</p></li>
          <li><h3>Sign in</h3><p>Verify your mobile number with a one-time code.</p></li>
          <li><h3>Open a live match</h3><p>Choose a fixture in the app to watch or check the score.</p></li>
        </ol>
      </section>

      <section id="download" className="sports-home-width sports-home-download" aria-labelledby="sports-home-download">
        <img className="sports-home-app-icon" src="/app-icon.png" alt="" width={72} height={72} />
        <div>
          <h2 id="sports-home-download">Get JBMR Sports</h2>
          <div className="sports-home-actions">
            <a className="sports-home-button" href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">
              <img src="/figma-v2/icon-apple.svg" alt="" width={20} height={20} />
              App Store
            </a>
            <a className="sports-home-button" href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer">
              <span aria-hidden="true">▶</span>
              Google Play
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
