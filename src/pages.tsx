
const APP_STORE_URL = 'https://apps.apple.com/in/app/jbmr-sports/id6808138064'
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=in.jbmrsports.ott'

const FEATURES = [
  {
    icon: '/figma-v2/icon-play-circle.svg',
    tone: 'cyan',
    title: 'Live stream',
    body: 'Watch the match in the app on Cloudflare Stream — play and pause, built for the ground camera.',
  },
  {
    icon: '/figma-v2/icon-chart.svg',
    tone: 'orange',
    title: 'Live scoreboard',
    body: 'Runs, wickets and overs update as the scorer saves the ball. Score is not delayed for video.',
  },
  {
    icon: '/figma-v2/icon-scissors.svg',
    tone: 'cyan',
    title: 'Ball-by-ball clips',
    body: 'Each ball gets a 10-second cut around the scoring moment — five seconds before, five after.',
  },
  {
    icon: '/figma-v2/icon-play-reel.svg',
    tone: 'orange',
    title: 'Shorts',
    body: 'Vertical clips you can watch and share. Like and earn screens stay in the app.',
  },
  {
    icon: '/figma-v2/icon-calendar.svg',
    tone: 'cyan',
    title: 'Schedule',
    body: 'Live, upcoming and completed fixtures for your tournaments — open a match from the list.',
  },
  {
    icon: '/figma-v2/icon-card.svg',
    tone: 'orange',
    title: 'Scorecard & squads',
    body: 'Innings, batting, bowling and squads on Match Center. Same feed as scoring.',
  },
  {
    icon: '/figma-v2/icon-bell.svg',
    tone: 'cyan',
    title: 'Phone login',
    body: 'OTP on first sign-in, then a PIN so you can open the app without waiting on SMS.',
  },
  {
    icon: '/figma-v2/icon-save.svg',
    tone: 'orange',
    title: 'Watchlist & downloads',
    body: 'Save matches, keep watch history, and download ball clips to the phone.',
  },
]

export function HomePage() {
  return (
    <div className="lp">
      <section className="lp-hero">
        <div className="lp-hero-glow" aria-hidden />
        <div className="lp-hero-grid" aria-hidden />
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <p className="web-pill">JBMR Sports app</p>
            <h1>
              Cricket lives
              <span> in the app</span>
            </h1>
            <p className="lp-lead">
              Live video, realtime scores, ball clips and shorts — on iPhone and Android. This
              website is only the door. Matches are not streamed here.
            </p>
            <div className="web-hero-v2-actions">
              <a className="web-btn-cta" href="#download">
                <img src="/figma-v2/icon-download.svg" alt="" width={20} height={20} />
                Get the app
              </a>
              <a className="web-btn-ghost" href="#features">
                See features
              </a>
            </div>
            <ul className="lp-badges">
              <li>iOS + Android</li>
              <li>PIN after OTP</li>
              <li>10s ball clips</li>
            </ul>
          </div>
          <div className="lp-phones" aria-hidden>
            <div className="lp-phone lp-phone-back">
              <div className="lp-phone-screen">
                <span className="lp-chip">LIVE</span>
                <p className="lp-phone-kicker">Match Center</p>
                <p className="lp-phone-title">Watch in the app</p>
                <div className="lp-score-bar">
                  <span>Scoreboard</span>
                  <span>Realtime</span>
                </div>
              </div>
            </div>
            <div className="lp-phone lp-phone-front">
              <div className="lp-phone-screen lp-phone-screen-clip">
                <span className="lp-chip lp-chip-orange">CLIP</span>
                <p className="lp-phone-kicker">Ball video</p>
                <p className="lp-phone-title">10 second cut</p>
                <div className="lp-clip-track">
                  <i />
                  <span>−5s</span>
                  <b>score</b>
                  <span>+5s</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="web-fig-section">
        <SectionHeader
          kicker="Inside the app"
          title="What you get"
          subtitle="Every feature below is on iOS and Android. Nothing on this page is a live score or match feed."
        />
        <div className="lp-feature-grid">
          {FEATURES.map((item) => (
            <article key={item.title} className="web-feature-card">
              <div className={`web-feature-icon ${item.tone}`}>
                <img src={item.icon} alt="" width={24} height={24} />
              </div>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="how" className="web-fig-section">
        <SectionHeader
          kicker="Simple path"
          title="How to watch"
          subtitle="The website does not play live cricket. Open the app for video and scores."
        />
        <ol className="lp-steps">
          <li>
            <strong>01</strong>
            <h3>Install JBMR Sports</h3>
            <p>App Store or Google Play — same account on both phones.</p>
          </li>
          <li>
            <strong>02</strong>
            <h3>Sign in</h3>
            <p>Verify with OTP once, then use your PIN next time.</p>
          </li>
          <li>
            <strong>03</strong>
            <h3>Open a match</h3>
            <p>Live stream, scoreboard, ball clips and shorts stay in the app.</p>
          </li>
        </ol>
      </section>

      <section id="download" className="web-fig-section web-download-section">
        <div className="web-download-card">
          <div className="web-download-copy">
            <h2>Get JBMR Sports</h2>
            <p>Live cricket, clips and shorts only in the iOS and Android apps.</p>
            <div className="web-store-row">
              <a
                className="web-store-btn"
                href={APP_STORE_URL}
                target="_blank"
                rel="noreferrer"
              >
                <img src="/figma-v2/icon-apple.svg" alt="" width={20} height={20} />
                <span>
                  <small>Download on the</small>
                  App Store
                </span>
              </a>
              <a className="web-store-btn" href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer">
                <img src="/figma-v2/icon-play-store.svg" alt="" width={20} height={20} />
                <span>
                  <small>GET IT ON</small>
                  Google Play
                </span>
              </a>
            </div>
          </div>
          <img className="web-download-icon" src="/app-icon.png" alt="JBMR Sports" width={160} height={160} />
        </div>
      </section>
    </div>
  )
}

function SectionHeader({
  kicker,
  title,
  subtitle,
}: {
  kicker: string
  title: string
  subtitle: string
}) {
  return (
    <header className="web-fig-head">
      <p className="web-pill sm">{kicker}</p>
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </header>
  )
}
